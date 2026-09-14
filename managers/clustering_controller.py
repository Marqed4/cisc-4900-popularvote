import os
import json
import re

from google import genai

_client = genai.Client(api_key=os.environ.get('GEMINI_API_KEY'))
_MODEL = 'gemini-2.5-flash'


def _clean_json(raw):
    cleaned = raw.strip()
    cleaned = re.sub(r'^```json\n?', '', cleaned)
    cleaned = re.sub(r'^```\n?', '', cleaned)
    cleaned = re.sub(r'```$', '', cleaned)
    return cleaned.strip()


def _generate(prompt, system_instruction=None):
    config = {'system_instruction': system_instruction} if system_instruction else None
    response = _client.models.generate_content(model=_MODEL, contents=prompt, config=config)
    return response.text.strip()


def cluster(submissions, tags=None):
    tags = tags or []
    if not submissions:
        raise ValueError('No submissions to cluster')

    questions = '\n'.join(f'{i + 1}. {s["content"]}' for i, s in enumerate(submissions))
    tag_context = f'The session topic is: {", ".join(tags)}.' if tags else ''

    prompt = f"""You are helping organize anonymous questions submitted during a group session.
{tag_context}

Here are all the submitted questions:
{questions}

Your task:
- Group semantically similar questions together into clusters
- For each cluster, write a single clear representative query that captures the theme
- Count approximately how many submissions contributed to each cluster
- List the original questions that belong to each cluster
- If a submission contains multiple questions, treat each as a separate question
- Aim for 3-7 clusters depending on how many questions there are

Respond ONLY with a valid JSON array, no markdown, no explanation, just the array:
[
  {{
    "representativeQuery": "clear question representing this cluster",
    "submissionCount": 3,
    "questions": ["original question 1", "original question 2", "original question 3"]
  }}
]"""

    try:
        raw = _generate(prompt)
        clusters = json.loads(_clean_json(raw))
        if not isinstance(clusters, list):
            raise ValueError('Gemini did not return anything')

        normalized = []
        for c in clusters:
            qs = c.get('questions') or []
            c['questions'] = [
                {'text': q, 'upvoteCount': 0} if isinstance(q, str) else q for q in qs
            ]
            normalized.append(c)
        return normalized
    except Exception as err:
        print('ClusteringEngine error:', err)
        raise Exception(f'Clustering failed {err}')


def regenerate_representative_query(cluster_obj):
    questions = '\n'.join(cluster_obj['questions'])

    prompt = f"""Given these questions from a group session:
{questions}

Write a single clear representative query that captures the main theme of these questions.
Respond with ONLY the query string, nothing else."""

    try:
        return _generate(prompt)
    except Exception as err:
        print('regenerateRepresentativeQuery error:', err)
        raise Exception(f'Failed to regenerate query {err}')


def generate_followup_suggestions(cluster_query, answer, questions=None):
    questions = questions or []
    question_list = '\n'.join(f'- {q.get("text", q) if isinstance(q, dict) else q}' for q in questions[:10])

    prompt = f"""A group Q&A session just produced this answer from the host.

Topic/question cluster: "{cluster_query}"
Host's answer: "{answer}"
{f"\nSome of the questions that were asked:\n{question_list}" if question_list else ''}

Generate exactly 3 short, natural follow-up questions a participant might want to ask after reading this answer. They should:
- Build directly on what was answered, not repeat it
- Be specific and concrete, not vague
- Sound like something a real person would ask
- Be under 15 words each

Respond ONLY with a valid JSON array of 3 strings, no markdown, no explanation:
["follow-up 1", "follow-up 2", "follow-up 3"]"""

    try:
        raw = _generate(prompt)
        result = json.loads(_clean_json(raw))
        if not isinstance(result, list):
            raise ValueError('Expected array')
        return result[:3]
    except Exception as err:
        print('generateFollowupSuggestions error:', err)
        return []


def generate_suggested_answer(cluster_obj, host_notes, session_title='', session_description=''):
    questions = (cluster_obj.get('questions') or [])[:10]
    question_list = '\n'.join(f'- {q.get("text", q) if isinstance(q, dict) else q}' for q in questions)

    prompt = f"""You are assisting a session host in drafting a response to a group of questions.

<session_context>
{f'Title: {session_title}' if session_title else ''}
{f'Description: {session_description}' if session_description else ''}
</session_context>

<host_notes>
{host_notes}
</host_notes>

<participant_questions>
Cluster theme: "{cluster_obj.get('representative_query')}"
{question_list}
</participant_questions>

Using ONLY information from the host notes above, draft a clear and concise response to this cluster of questions.
- Stay grounded in the notes - do not invent facts
- Be direct and helpful, 2-4 sentences
- If the notes don't contain relevant information, say so honestly
- IMPORTANT: Do NOT mention the host notes, say "based on the notes", or reveal that you used any source material. Just give the answer directly as if the host is speaking.

Respond with plain text only, no markdown, no preamble."""

    try:
        return _generate(prompt)
    except Exception as err:
        print('[generateSuggestedAnswer] error:', err)
        return None


def incremental_cluster(new_submissions, existing_clusters, tags=None):
    tags = tags or []
    tag_context = f'The session topic is: {", ".join(tags)}.' if tags else ''

    existing_list = '\n'.join(f'- Cluster ID "{c["id"]}": "{c["representative_query"]}"' for c in existing_clusters)
    submission_list = '\n'.join(f'{i}: "{s["content"]}"' for i, s in enumerate(new_submissions))

    prompt = f"""You are helping organize new questions submitted during a live Q&A session.
{tag_context}

These clusters already exist and have been answered by the host. Do NOT change them - only add new questions to them if they fit:
{existing_list}

These are NEW submissions that just came in (indexed 0 to {len(new_submissions) - 1}):
{submission_list}

Your task:
- For each new submission, either assign it to an existing cluster (if it fits semantically) OR group it with other unassigned submissions into a new cluster
- If assigning to an existing cluster, use the exact Cluster ID string shown above
- New clusters should only be created for questions that don't fit any existing cluster
- For new clusters, write a clear representative query capturing the theme

Respond ONLY with a valid JSON object, no markdown, no explanation:
{{
  "assignments": [
    {{ "submissionIndex": 0, "clusterId": "exact-uuid-from-above" }}
  ],
  "newClusters": [
    {{ "representativeQuery": "theme of new questions", "submissionIndices": [1, 2] }}
  ]
}}"""

    try:
        raw = _generate(prompt)
        result = json.loads(_clean_json(raw))

        if 'assignments' not in result or 'newClusters' not in result:
            raise ValueError('Gemini returned unexpected shape')

        added_map = {}
        for assignment in result['assignments']:
            sub = new_submissions[assignment['submissionIndex']] if assignment['submissionIndex'] < len(new_submissions) else None
            if not sub:
                continue
            added_map.setdefault(assignment['clusterId'], []).append({'text': sub['content'], 'upvoteCount': 0})

        updated_clusters = [
            {'clusterId': cluster_id, 'addedQuestions': added_questions}
            for cluster_id, added_questions in added_map.items()
        ]

        new_clusters = []
        for nc in result['newClusters']:
            subs = [new_submissions[i] for i in nc['submissionIndices'] if i < len(new_submissions)]
            questions = [{'text': s['content'], 'upvoteCount': 0} for s in subs]
            new_clusters.append({
                'representativeQuery': nc['representativeQuery'],
                'submissionCount': len(questions),
                'questions': questions,
            })

        return {'updatedClusters': updated_clusters, 'newClusters': new_clusters}
    except Exception as err:
        print('incrementalCluster error:', err)
        raise Exception(f'Incremental clustering failed: {err}')


def generate_expansion_preview(clusters, tags=None, existing_facts=None):
    tags = tags or []
    existing_facts = existing_facts or []

    def summarize(c):
        participant_answers = c.get('participant_answers') or []
        participant_block = f"Participant answers:\n" + '\n'.join(f'- {a}' for a in participant_answers) if participant_answers else ''
        host_answer = f"Host answer: {c['answer']}" if c.get('answer') else ''
        selected_questions = c.get('selected_questions') or []
        selected_block = f"Previously selected follow-ups:\n" + '\n'.join(f'- {q}' for q in selected_questions) if selected_questions else ''
        return f'Cluster ID "{c["id"]}": "{c["representative_query"]}"\n{host_answer}\n{participant_block}\n{selected_block}'.strip()

    cluster_summary = '\n\n'.join(summarize(c) for c in clusters)
    tag_context = f'The session topic is: {", ".join(tags)}.' if tags else ''
    facts_context = ('Known contextual facts from this session:\n' + '\n'.join(f'- {f}' for f in existing_facts)) if existing_facts else ''

    prompt = f"""You are helping a host expand a group Q&A session into a deeper discussion.
{tag_context}

Here are the current clusters with their answers:
{cluster_summary}

{facts_context}

Your task:
- For each cluster, generate 3-5 follow-up questions that would deepen understanding
- Extract 2-4 contextual facts that are implied or stated in the answers and would be useful context going forward
- Follow-up questions should build on what was already answered, not repeat it
- Contextual facts should be concise, neutral statements of information surfaced in this session

IMPORTANT: Each cluster above has a "Cluster ID" shown in quotes. You MUST use that exact ID string as the clusterId in your response.

Respond ONLY with a valid JSON object, no markdown, no explanation:
{{
  "clusterPreviews": [
    {{
      "clusterId": "the exact cluster ID string from above",
      "previewedQuestions": ["follow-up question 1", "follow-up question 2", "follow-up question 3"]
    }}
  ],
  "contextualFacts": ["fact 1", "fact 2", "fact 3"]
}}"""

    try:
        raw = _generate(prompt)
        result = json.loads(_clean_json(raw))

        if 'clusterPreviews' not in result or not isinstance(result['clusterPreviews'], list):
            raise ValueError('Gemini did not return valid expansion preview')

        remapped = []
        for preview in result['clusterPreviews']:
            cluster_id = preview['clusterId']
            try:
                idx = int(cluster_id)
                cluster_id = clusters[idx]['id'] if idx < len(clusters) else preview['clusterId']
            except (ValueError, TypeError):
                pass
            remapped.append({**preview, 'clusterId': cluster_id})
        result['clusterPreviews'] = remapped

        return result
    except Exception as err:
        print('generateExpansionPreview error:', err)
        raise Exception(f'Expansion preview failed {err}')
