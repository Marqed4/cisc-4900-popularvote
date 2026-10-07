"""Socket.IO event handlers.

Quick overview: every connected browser gets a socket id (`request.sid`). Joining a
session by code drops that socket into a Socket.IO room named after the code. Emitting
`to=code` hits everyone in the session, and `to=<sid>` hits just one socket.

Event cheat sheet
  Client -> server                 Server -> client
  join:room                        session:sync (to the joiner), participant:joined (room)
  leave:room                       nothing
  host:delete_session              session:deleted (room)
  pubkey_exchange (E2E)            pubkey_exchange (room, minus sender)
  room_key_distribute (E2E)        room_key_distribute (one target socket)
  disconnect (automatic)           participant:left (room)

The encrypted-session events are relay only. The server never holds a private key or the
room key and never decrypts anything. The client half lives in
src/frontend/src/lib/crypto.js.
"""
from flask import request
from flask_socketio import join_room, leave_room

# In-memory map of who each connected socket is. Filled in on join:room, removed on
# disconnect. A restart wipes it, which is fine since clients reconnect and rejoin.
# socket_id -> { 'code': str, 'role': str }
_socket_state = {}


def register(socketio, session_manager):
    """Hook every event handler up to the SocketIO instance (app.py calls this once)."""

    @socketio.on('host:delete_session')
    def on_delete_session(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        # Only a socket that joined as host can delete. Heads up: the role comes straight
        # from the client's join:room payload and the server doesn't verify it (issue #4).
        if state.get('role') != 'host':
            socketio.emit('error', {'message': 'Unauthorized'}, to=sid)
            return

        code = data.get('code')
        try:
            session_manager.delete_session(code)
            # Let everyone in the room know so their UIs can back out.
            socketio.emit('session:deleted', to=code)
        except Exception as err:
            socketio.emit('error', {'message': str(err)}, to=sid)

    @socketio.on('join:room')
    def on_join_room(data):
        sid = request.sid
        code = data.get('code')
        role = data.get('role')  # 'host' or 'participant', sent by the client

        # Check memory first, then fall back to the database (like after a restart,
        # before hydrate() has loaded this session).
        session = session_manager.get_session(code)
        if not session:
            try:
                session = session_manager.get_session_async(code)
            except Exception:
                session = None
        if not session:
            socketio.emit('error', {'message': 'Session not found'}, to=sid)
            return

        join_room(code)
        _socket_state[sid] = {'code': code, 'role': role}
        print(f'Socket {sid} joined room {code} as {role}')

        # Hosts don't count toward the live participant total, only participants.
        if role == 'participant':
            count = _participant_count(socketio, code)
            session['participantCount'] = count
            socketio.emit('participant:joined', {'socketId': sid, 'count': count}, to=code)

        # Give the joiner a snapshot of the current state so the UI can render right away.
        # `encrypted` is what tells the client to start the E2E key exchange.
        socketio.emit('session:sync', {
            'code': session['code'],
            'phase': session['phase'],
            'tags': session['tags'],
            'participantCount': session['participantCount'],
            'submissionCount': len(session['submissions']),
            'clusters': session['clusters'],
            'curators': session['curators'],
            'contextualFacts': session['contextualFacts'],
            'encrypted': session.get('encrypted', False),
        }, to=sid)

    # --- End-to-end encryption relay ---------------------------------------------------
    # How it flows: a joiner broadcasts its public key (pubkey_exchange). The host answers
    # that joiner only, with the room key wrapped for them (room_key_distribute). The
    # server just passes these along and can't read the payloads.

    @socketio.on('pubkey_exchange')
    def on_pubkey_exchange(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        code = state.get('code')
        if not code:
            socketio.emit('error', {'message': 'Not in a session'}, to=sid)
            return

        # Send the sender's public key to the rest of the room. `socketId` is how the host
        # knows where to send its reply. Public keys aren't secret, but nothing here proves
        # whose key it is, so fingerprint checks are still needed (E2E-7).
        socketio.emit('pubkey_exchange', {
            'socketId': sid, 'publicKey': data.get('publicKey'),
        }, to=code, skip_sid=sid)

    @socketio.on('room_key_distribute')
    def on_room_key_distribute(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        if not state.get('code'):
            socketio.emit('error', {'message': 'Not in a session'}, to=sid)
            return

        target_sid = data.get('targetSocketId')
        if not target_sid:
            return
        # Only relay inside the sender's own room so nobody can push key material to a
        # socket in a different session.
        if _socket_state.get(target_sid, {}).get('code') != state['code']:
            socketio.emit('error', {'message': 'Target not in this session'}, to=sid)
            return

        # `encryptedRoomKey` is the room key wrapped for the target (ciphertext only).
        # `publicKey` is the sender's public key, which the target needs to unwrap it.
        # Joiners would never see the host's key otherwise since it isn't broadcast.
        socketio.emit('room_key_distribute', {
            'fromSocketId': sid,
            'encryptedRoomKey': data.get('encryptedRoomKey'),
            'publicKey': data.get('publicKey'),
        }, to=target_sid)

    @socketio.on('leave:room')
    def on_leave_room(data):
        sid = request.sid
        code = data.get('code')
        leave_room(code)
        # _socket_state gets cleaned up on disconnect, not here.
        print(f'Socket {sid} left room {code}')

    @socketio.on('disconnect')
    def on_disconnect():
        sid = request.sid
        print(f'Socket disconnected: {sid}')
        # Drop this socket's state, then recount participants without it.
        state = _socket_state.pop(sid, None)
        if state and state.get('code'):
            code = state['code']
            session = session_manager.get_session(code)
            if session:
                count = _participant_count(socketio, code, exclude_sid=sid)
                session['participantCount'] = count
                socketio.emit('participant:left', {'count': count}, to=code)


def _participant_count(socketio, code, exclude_sid=None):
    """Count the sockets in room `code` whose role is 'participant'.

    Reads Socket.IO's internal room table for the default '/' namespace. `exclude_sid`
    skips a socket that's mid-disconnect and might still show up in the room.
    """
    room = socketio.server.manager.rooms.get('/', {}).get(code)
    if not room:
        return 0
    count = 0
    for sid in room:
        if sid == exclude_sid:
            continue
        state = _socket_state.get(sid)
        if state and state.get('role') == 'participant':
            count += 1
    return count


def to_session(socketio, code, event, data):
    """Emit `event` to everyone in session `code`. The HTTP routes use this."""
    socketio.emit(event, data, to=code)


def to_session_except(socketio, exclude_sid, code, event, data):
    """Emit `event` to everyone in session `code` except socket `exclude_sid`."""
    socketio.emit(event, data, to=code, skip_sid=exclude_sid)
