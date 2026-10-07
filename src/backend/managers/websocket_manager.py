"""Socket.IO event handlers.

Every connected browser gets a socket id (`request.sid`). A client "joins" a session by
code, which puts its socket in a Socket.IO room named after that code. Anything emitted
`to=code` reaches everyone in that session; `to=<sid>` reaches one socket.

Event summary
  Client -> server                 Server -> client
  join:room                        session:sync (to the joiner), participant:joined (room)
  leave:room                       -
  host:delete_session              session:deleted (room)
  pubkey_exchange (E2E)            pubkey_exchange (room, minus sender)
  room_key_distribute (E2E)        room_key_distribute (one target socket)
  disconnect (automatic)           participant:left (room)

The encrypted-session events only relay data. The server never holds a private key or
room key, and never decrypts. See src/frontend/src/lib/crypto.js for the client side.
"""
from flask import request
from flask_socketio import join_room, leave_room

# In-memory map of who each connected socket is, filled in on join:room and removed on
# disconnect. Lost on restart, which is fine because clients reconnect and rejoin.
# socket_id -> { 'code': str, 'role': str }
_socket_state = {}


def register(socketio, session_manager):
    """Attach all event handlers to the SocketIO instance (called once from app.py)."""

    @socketio.on('host:delete_session')
    def on_delete_session(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        # Only a socket that joined as host may delete. NOTE: the role comes from the
        # client's own join:room payload and is not verified server-side.
        if state.get('role') != 'host':
            socketio.emit('error', {'message': 'Unauthorized'}, to=sid)
            return

        code = data.get('code')
        try:
            session_manager.delete_session(code)
            # Tell everyone in the room so their UIs can leave the session.
            socketio.emit('session:deleted', to=code)
        except Exception as err:
            socketio.emit('error', {'message': str(err)}, to=sid)

    @socketio.on('join:room')
    def on_join_room(data):
        sid = request.sid
        code = data.get('code')
        role = data.get('role')  # 'host' or 'participant', supplied by the client

        # Look in memory first, then fall back to the database (for example after a
        # server restart, before hydrate() has loaded this session).
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

        # Only participants count toward the live participant total, not hosts.
        if role == 'participant':
            count = _participant_count(socketio, code)
            session['participantCount'] = count
            socketio.emit('participant:joined', {'socketId': sid, 'count': count}, to=code)

        # Send the joiner a snapshot of current state so the UI can render immediately.
        # `encrypted` tells the client whether to run the E2E key exchange.
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
    # Flow: a joiner broadcasts its public key (pubkey_exchange). The host replies to that
    # joiner only, with the room key wrapped for them (room_key_distribute). The server
    # just forwards these messages; the payloads are opaque to it.

    @socketio.on('pubkey_exchange')
    def on_pubkey_exchange(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        code = state.get('code')
        if not code:
            socketio.emit('error', {'message': 'Not in a session'}, to=sid)
            return

        # Broadcast the sender's public key to the rest of the room. `socketId` lets the
        # host address its reply. Public keys are not secret, but they are also not
        # authenticated here, so a client should verify fingerprints (see E2E-7).
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
        # Only relay keys within the sender's own room, so a socket cannot push key
        # material to someone in a different session.
        if _socket_state.get(target_sid, {}).get('code') != state['code']:
            socketio.emit('error', {'message': 'Target not in this session'}, to=sid)
            return

        # `encryptedRoomKey` is the room key wrapped for the target (ciphertext only).
        # `publicKey` is the sender's public key, which the target needs to unwrap it
        # (joiners never see the host's key otherwise, since it is not broadcast).
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
        # _socket_state is not cleared here, only on disconnect.
        print(f'Socket {sid} left room {code}')

    @socketio.on('disconnect')
    def on_disconnect():
        sid = request.sid
        print(f'Socket disconnected: {sid}')
        # Drop the socket's state, then recompute the participant count without it.
        state = _socket_state.pop(sid, None)
        if state and state.get('code'):
            code = state['code']
            session = session_manager.get_session(code)
            if session:
                count = _participant_count(socketio, code, exclude_sid=sid)
                session['participantCount'] = count
                socketio.emit('participant:left', {'count': count}, to=code)


def _participant_count(socketio, code, exclude_sid=None):
    """Count sockets in room `code` whose role is 'participant'.

    Reads Socket.IO's internal room table for the default '/' namespace. `exclude_sid`
    skips a socket that is mid-disconnect and may still appear in the room.
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
    """Emit `event` to everyone in session `code`. Used by the HTTP routes."""
    socketio.emit(event, data, to=code)


def to_session_except(socketio, exclude_sid, code, event, data):
    """Emit `event` to everyone in session `code` except socket `exclude_sid`."""
    socketio.emit(event, data, to=code, skip_sid=exclude_sid)
