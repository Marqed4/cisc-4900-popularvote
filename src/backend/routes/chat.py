import os
from flask import Blueprint, request, jsonify, current_app
from google import genai

chat_bp = Blueprint('chat', __name__)
_client = genai.Client(api_key=os.environ.get('GEMINI_API_KEY'))


@chat_bp.route('/chat', methods=['POST'])
def chat():
    body = request.get_json() or {}
    messages = body.get('messages')
    session_code = body.get('sessionCode')

    if not messages or not isinstance(messages, list):
        return jsonify({'error': 'messages array is required'}), 400

    try:
        session = current_app.session_manager.get_session(session_code)
        if session and session.get('encrypted'):
            return jsonify({'error': 'Chat is unavailable for encrypted sessions. Content never reaches the server as plaintext.'}), 400
        system_prompt = _build_cluster_narrative(session)

        contents = [
            {'role': 'model' if m['role'] == 'assistant' else 'user', 'parts': [{'text': m['content']}]}
            for m in messages
        ]

        response = _client.models.generate_content(
            model='gemini-2.5-flash',
            contents=contents,
            config={'system_instruction': system_prompt},
        )

        return jsonify({'reply': response.text})
    except Exception as err:
        print('Gemini error:', err)
        return jsonify({'error': 'Chat unavailable. Try again.'}), 500


def _build_cluster_narrative(session):
    if not session or not session.get('clusters'):
        return ('You are a helpful assistant for a Q&A session. No clusters have been generated yet.\n'
                '            Encourage the user to submit questions and wait for the host to trigger clustering.')

    tags = f'The session topic is: {", ".join(session["tags"])}.' if session.get('tags') else ''

    lines = []
    for i, cluster in enumerate(session['clusters']):
        originals = ''
        if cluster.get('questions'):
            originals = f'Original questions include: {" | ".join(cluster["questions"][:5])}'
        lines.append(
            f'Theme {i + 1}: "{cluster.get("representativeQuery")}", raised by approximately '
            f'{cluster.get("submissionCount")} participants. {originals}'
        )
    cluster_summary = '\n'.join(lines)

    return f"""You are a conversational assistant helping to explore the key themes that emerged from a group Q&A session.
{tags}

Here are the clustered themes from participant submissions:
{cluster_summary}

Your job:
- Help the user understand using group/topic context
- Draw connections between themes where relevant
- If asked about a specific theme, expand on what participants were likely trying to understand
- Suggest which themes and delve for clarity, what might be most important to address first based on submission counts?
- Keep responses concise and grounded in the actual clusters above, ask to rebase when things are convoluted
- Do not invent themes or questions without reviewing context, that's the most important constraint."""
