from flask import request
from flask_socketio import join_room, leave_room

# socket_id -> { 'code': str, 'role': str }
_socket_state = {}


def register(socketio, session_manager):

    @socketio.on('host:delete_session')
    def on_delete_session(data):
        sid = request.sid
        state = _socket_state.get(sid, {})
        if state.get('role') != 'host':
            socketio.emit('error', {'message': 'Unauthorized'}, to=sid)
            return

        code = data.get('code')
        try:
            session_manager.delete_session(code)
            socketio.emit('session:deleted', to=code)
        except Exception as err:
            socketio.emit('error', {'message': str(err)}, to=sid)

    @socketio.on('join:room')
    def on_join_room(data):
        sid = request.sid
        code = data.get('code')
        role = data.get('role')

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

        if role == 'participant':
            count = _participant_count(socketio, code)
            session['participantCount'] = count
            socketio.emit('participant:joined', {'socketId': sid, 'count': count}, to=code)

        socketio.emit('session:sync', {
            'code': session['code'],
            'phase': session['phase'],
            'tags': session['tags'],
            'participantCount': session['participantCount'],
            'submissionCount': len(session['submissions']),
            'clusters': session['clusters'],
            'curators': session['curators'],
            'contextualFacts': session['contextualFacts'],
        }, to=sid)

    @socketio.on('leave:room')
    def on_leave_room(data):
        sid = request.sid
        code = data.get('code')
        leave_room(code)
        print(f'Socket {sid} left room {code}')

    @socketio.on('disconnect')
    def on_disconnect():
        sid = request.sid
        print(f'Socket disconnected: {sid}')
        state = _socket_state.pop(sid, None)
        if state and state.get('code'):
            code = state['code']
            session = session_manager.get_session(code)
            if session:
                count = _participant_count(socketio, code, exclude_sid=sid)
                session['participantCount'] = count
                socketio.emit('participant:left', {'count': count}, to=code)


def _participant_count(socketio, code, exclude_sid=None):
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
    socketio.emit(event, data, to=code)


def to_session_except(socketio, exclude_sid, code, event, data):
    socketio.emit(event, data, to=code, skip_sid=exclude_sid)
