"""Socket.IO event handlers.

Quick overview: every connected browser gets a socket id (`request.sid`). Joining a
session by code drops that socket into a Socket.IO room named after the code. Emitting
`to=code` hits everyone in the session, and `to=<sid>` hits just one socket.

Event cheat sheet
  Client -> server                 Server -> client
  join:room                        session:sync (to the joiner), participant:joined (room)
  leave:room                       participant:left (room)
  host:delete_session              session:deleted (room)
  pubkey_exchange (E2E)            pubkey_exchange (room, minus sender)
  room_key_distribute (E2E)        room_key_distribute (one target socket)
  disconnect (automatic)           participant:left (room)

`join:room` carries `{code, role, deviceId}`. `deviceId` is a random id the browser keeps in
localStorage. A participant's first join from a new device bumps the session's `viewerCount`
(unique devices that have ever joined, so it never goes down). `participantCount` is still
the live number of connected participant sockets. Both ride on `participant:joined` and
`session:sync`.

The encrypted-session events are relay only. The server never holds a private key or the
room key and never decrypts anything. The client half lives in
src/frontend/src/lib/crypto.js.

Known limit: the role ('host' or 'participant') still comes from the client's join:room
payload and is not verified (issue #4). Every host-only check below is only as strong as
that claim until sessions get a host token. The device id has the same trust level: it is
client supplied, so `viewerCount` is a good-faith number, not a security boundary.
"""
import json
import logging
import re

from flask import request
from flask_socketio import join_room, leave_room

log = logging.getLogger(__name__)

# In-memory map of who each connected socket is. Filled in on join:room, removed on
# leave:room or disconnect. A restart wipes it, which is fine since clients reconnect
# and rejoin. This is per process: running several workers needs a shared store.
# socket_id -> { 'code': str, 'role': str, 'deviceId': str | None }
_socket_state = {}

_VALID_ROLES = ('host', 'participant')
_MAX_KEY_PAYLOAD = 16384  # characters. Generous for a public key or a wrapped room key.

# What crypto.randomUUID() produces (36 chars of hex and dashes) fits comfortably. Anything
# else is ignored rather than stored, so a client can't push junk into the database.
_DEVICE_ID_RE = re.compile(r'^[A-Za-z0-9_-]{8,64}$')


def _as_dict(data):
    # a client can emit anything, including nothing. Never call .get on the raw payload.
    return data if isinstance(data, dict) else {}


def _norm_code(code):
    return code.strip().upper() if isinstance(code, str) else ''


def _clean_device_id(value):
    """The device id if it looks like one, otherwise None."""
    value = value.strip() if isinstance(value, str) else ''
    return value if _DEVICE_ID_RE.match(value) else None


def _payload_ok(value):
    """True when `value` is present and small enough to relay."""
    if value is None:
        return False
    try:
        size = len(value) if isinstance(value, str) else len(json.dumps(value))
    except (TypeError, ValueError):
        return False
    return 0 < size <= _MAX_KEY_PAYLOAD


def _error(socketio, sid, message):
    socketio.emit('error', {'message': message}, to=sid)


def _record_viewer(session_manager, code, device_id):
    """Count this device once. A database hiccup must never stop someone from joining."""
    try:
        session_manager.record_viewer(code, device_id)
    except Exception as err:
        log.warning('viewer record failed for %s: %s', code, err)


def register(socketio, session_manager):
    """Hook every event handler up to the SocketIO instance (app.py calls this once)."""

    @socketio.on('host:delete_session')
    def on_delete_session(data):
        sid = request.sid
        state = _socket_state.get(sid) or {}
        # Only a socket that joined as host can delete, and only the session it joined.
        # The code in the payload is ignored (a mismatch is rejected) so a host of one
        # session cannot delete someone else's by sending a different code.
        if state.get('role') != 'host' or not state.get('code'):
            _error(socketio, sid, 'Unauthorized')
            return

        code = state['code']
        requested = _norm_code(_as_dict(data).get('code'))
        if requested and requested != code:
            _error(socketio, sid, 'Unauthorized')
            return

        try:
            session_manager.delete_session(code)
            # Let everyone in the room know so their UIs can back out.
            socketio.emit('session:deleted', to=code)
        except Exception as err:
            _error(socketio, sid, str(err))

    @socketio.on('join:room')
    def on_join_room(data):
        sid = request.sid
        data = _as_dict(data)
        code = _norm_code(data.get('code'))
        role = data.get('role') if data.get('role') in _VALID_ROLES else 'participant'

        if not code:
            _error(socketio, sid, 'Session not found')
            return

        # Check memory first, then fall back to the database (like after a restart,
        # before hydrate() has loaded this session). get_session_async is a plain
        # synchronous method despite the name.
        session = session_manager.get_session(code)
        if not session:
            try:
                session = session_manager.get_session_async(code)
            except Exception as err:
                log.warning('session lookup failed for %s: %s', code, err)
                session = None
        if not session:
            _error(socketio, sid, 'Session not found')
            return

        # A socket belongs to one session at a time. Moving to another code leaves the
        # old room first so counts and broadcasts don't leak between sessions.
        previous = _socket_state.get(sid)
        if previous and previous.get('code') and previous['code'] != code:
            leave_room(previous['code'])
            _socket_state.pop(sid, None)
            _announce_left(socketio, session_manager, previous['code'])

        # Only participants are counted as devices. One socket is one device: if it rejoins
        # the same room it keeps its first device id, so a client can't inflate the count by
        # emitting join:room over and over with a fresh id each time.
        device_id = None
        if role == 'participant':
            kept = previous.get('deviceId') if previous and previous.get('code') == code else None
            device_id = kept or _clean_device_id(data.get('deviceId'))

        join_room(code)
        _socket_state[sid] = {'code': code, 'role': role, 'deviceId': device_id}
        log.info('Socket %s joined room %s as %s', sid, code, role)

        # Hosts don't count toward the live participant total, only participants.
        if role == 'participant':
            count = _participant_count(socketio, code)
            session['participantCount'] = count
            if device_id:
                _record_viewer(session_manager, code, device_id)
            socketio.emit('participant:joined', {
                'socketId': sid,
                'count': count,
                'viewerCount': session.get('viewerCount', 0),
            }, to=code)

        # Give the joiner a snapshot of the current state so the UI can render right away.
        # `encrypted` is what tells the client to start the E2E key exchange.
        socketio.emit('session:sync', {
            'code': session['code'],
            'phase': session['phase'],
            'tags': session.get('tags', []),
            'participantCount': session.get('participantCount', 0),
            'viewerCount': session.get('viewerCount', 0),
            'submissionCount': len(session.get('submissions', [])),
            'clusters': session.get('clusters', []),
            'curators': session.get('curators', []),
            'contextualFacts': session.get('contextualFacts', []),
            'encrypted': session.get('encrypted', False),
        }, to=sid)

    # --- End-to-end encryption relay ---------------------------------------------------
    # How it flows: a joiner broadcasts its public key (pubkey_exchange). The host answers
    # that joiner only, with the room key wrapped for them (room_key_distribute). The
    # server just passes these along and can't read the payloads.

    @socketio.on('pubkey_exchange')
    def on_pubkey_exchange(data):
        sid = request.sid
        state = _socket_state.get(sid) or {}
        code = state.get('code')
        if not code:
            _error(socketio, sid, 'Not in a session')
            return

        public_key = _as_dict(data).get('publicKey')
        if not _payload_ok(public_key):
            _error(socketio, sid, 'Invalid key payload')
            return

        # Send the sender's public key to the rest of the room. `socketId` is how the host
        # knows where to send its reply. Public keys aren't secret, but nothing here proves
        # whose key it is, so fingerprint checks are still needed (E2E-7).
        socketio.emit('pubkey_exchange', {
            'socketId': sid, 'publicKey': public_key,
        }, to=code, skip_sid=sid)

    @socketio.on('room_key_distribute')
    def on_room_key_distribute(data):
        sid = request.sid
        state = _socket_state.get(sid) or {}
        if not state.get('code'):
            _error(socketio, sid, 'Not in a session')
            return

        # Only the host hands out the room key. Without this, any participant could push
        # a key of their own at everyone else in the room.
        if state.get('role') != 'host':
            _error(socketio, sid, 'Only the host can distribute the room key')
            return

        data = _as_dict(data)
        target_sid = data.get('targetSocketId')
        if not isinstance(target_sid, str) or not target_sid:
            return
        # Only relay inside the sender's own room so nobody can push key material to a
        # socket in a different session.
        if (_socket_state.get(target_sid) or {}).get('code') != state['code']:
            _error(socketio, sid, 'Target not in this session')
            return

        encrypted_room_key = data.get('encryptedRoomKey')
        public_key = data.get('publicKey')
        if not _payload_ok(encrypted_room_key) or not _payload_ok(public_key):
            _error(socketio, sid, 'Invalid key payload')
            return

        # `encryptedRoomKey` is the room key wrapped for the target (ciphertext only).
        # `publicKey` is the sender's public key, which the target needs to unwrap it.
        # Joiners would never see the host's key otherwise since it isn't broadcast.
        socketio.emit('room_key_distribute', {
            'fromSocketId': sid,
            'encryptedRoomKey': encrypted_room_key,
            'publicKey': public_key,
        }, to=target_sid)

    @socketio.on('leave:room')
    def on_leave_room(data):
        sid = request.sid
        state = _socket_state.pop(sid, None)
        # Prefer the room the server knows this socket is in over the client's claim.
        code = state['code'] if state and state.get('code') else _norm_code(_as_dict(data).get('code'))
        if code:
            leave_room(code)
            log.info('Socket %s left room %s', sid, code)
        if state and state.get('code'):
            # the socket is gone from _socket_state already, so the recount excludes it
            _announce_left(socketio, session_manager, state['code'])

    @socketio.on('disconnect')
    def on_disconnect():
        sid = request.sid
        log.info('Socket disconnected: %s', sid)
        # Drop this socket's state, then recount participants without it.
        state = _socket_state.pop(sid, None)
        if state and state.get('code'):
            _announce_left(socketio, session_manager, state['code'], exclude_sid=sid)


def _announce_left(socketio, session_manager, code, exclude_sid=None):
    """Recount the room after someone left and tell everyone still in it."""
    session = session_manager.get_session(code)
    if not session:
        return
    count = _participant_count(socketio, code, exclude_sid=exclude_sid)
    session['participantCount'] = count
    socketio.emit('participant:left', {'count': count}, to=code)


def _participant_count(socketio, code, exclude_sid=None):
    """Count the sockets in session `code` whose role is 'participant'.

    Counts from our own _socket_state instead of Socket.IO's private room table, which
    can change between library versions. `socketio` is unused and only kept so existing
    callers keep working. `exclude_sid` skips a socket that is mid-disconnect.
    """
    return sum(
        1 for s, st in _socket_state.items()
        if s != exclude_sid and st.get('code') == code and st.get('role') == 'participant'
    )


def to_session(socketio, code, event, data):
    """Emit `event` to everyone in session `code`. The HTTP routes use this."""
    socketio.emit(event, data, to=code)


def to_session_except(socketio, exclude_sid, code, event, data):
    """Emit `event` to everyone in session `code` except socket `exclude_sid`."""
    socketio.emit(event, data, to=code, skip_sid=exclude_sid)