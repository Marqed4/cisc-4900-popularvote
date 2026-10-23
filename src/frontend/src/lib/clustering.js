/*
 * clustering.js: client-side question clustering for encrypted sessions.
 *
 * Encrypted sessions never let plaintext questions reach the server (see crypto.js),
 * so the Gemini-based clustering in managers/clustering_controller.py can't run - the
 * server never has anything to read. This module does the same job (group similar
 * questions, pick a representative query per group) entirely in the browser, using
 * only the already-decrypted plaintext the host already holds in memory.
 *
 * Approach: TF-IDF vectors + cosine similarity, single-pass greedy clustering. No
 * network calls, no model download. Deterministic and fast enough for the question
 * counts a live Q&A session produces (tens to low hundreds).
 *
 * Output shape intentionally matches what managers/clustering_controller.cluster()
 * returns server-side, so routes/sessions.py and session_store.py don't need an
 * encrypted-specific code path to store the result:
 *   [{ representativeQuery, submissionCount, questions: [{ text, upvoteCount }] }]
 */

const STOPWORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'for', 'with', 'at', 'by', 'from', 'about',
  'and', 'or', 'but', 'if', 'so', 'as', 'it', 'its', 'this', 'that',
  'what', 'when', 'where', 'who', 'why', 'how', 'do', 'does', 'did',
  'can', 'could', 'will', 'would', 'should', 'you', 'your', 'we', 'i',
]);

function tokenize(text) {
  return (text.toLowerCase().match(/[a-z0-9']+/g) || []).filter(w => w.length > 1 && !STOPWORDS.has(w));
}

function buildTfidf(documents) {
  const docTokens = documents.map(tokenize);
  const df = new Map();
  docTokens.forEach(tokens => {
    new Set(tokens).forEach(t => df.set(t, (df.get(t) || 0) + 1));
  });

  const n = documents.length;
  return docTokens.map(tokens => {
    const tf = new Map();
    tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
    const vec = new Map();
    tf.forEach((count, term) => {
      const idf = Math.log((n + 1) / ((df.get(term) || 0) + 1)) + 1;
      vec.set(term, (count / tokens.length) * idf);
    });
    return vec;
  });
}

function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  a.forEach((val, key) => {
    normA += val * val;
    if (b.has(key)) dot += val * b.get(key);
  });
  b.forEach(val => { normB += val * val; });
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Greedy single-pass clustering: each submission joins the first existing cluster
 * whose centroid-ish seed vector it's similar enough to, otherwise starts a new one.
 *
 * @param {Array<{id: string|number, content: string}>} submissions - decrypted questions
 * @param {{ minSimilarity?: number, maxClusters?: number }} [options]
 */
export function clusterQuestions(submissions, options = {}) {
  const { minSimilarity = 0.15, maxClusters = 12 } = options;

  const valid = submissions.filter(s => (s.content || '').trim().length > 0);
  if (valid.length === 0) return [];

  const vectors = buildTfidf(valid.map(s => s.content));

  const clusters = []; // { seedVector, members: [{content}] }

  valid.forEach((sub, i) => {
    const vec = vectors[i];
    let best = null;
    let bestScore = minSimilarity;

    clusters.forEach(cluster => {
      const score = cosineSimilarity(vec, cluster.seedVector);
      if (score > bestScore) {
        bestScore = score;
        best = cluster;
      }
    });

    if (best) {
      best.members.push(sub);
    } else if (clusters.length < maxClusters) {
      clusters.push({ seedVector: vec, members: [sub] });
    } else {
      // Cluster cap hit: fall back to the closest existing cluster regardless of threshold.
      let closest = clusters[0];
      let closestScore = -1;
      clusters.forEach(cluster => {
        const score = cosineSimilarity(vec, cluster.seedVector);
        if (score > closestScore) {
          closestScore = score;
          closest = cluster;
        }
      });
      closest.members.push(sub);
    }
  });

  return clusters.map(cluster => ({
    representativeQuery: pickRepresentative(cluster.members),
    submissionCount: cluster.members.length,
    questions: cluster.members.map(m => ({ text: m.content, upvoteCount: 0 })),
  }));
}

// Picks the member whose words appear most across the cluster (a cheap stand-in
// for "most central" without doing a second similarity pass against a true centroid).
function pickRepresentative(members) {
  if (members.length === 1) return members[0].content;

  const wordCounts = new Map();
  members.forEach(m => {
    new Set(tokenize(m.content)).forEach(w => wordCounts.set(w, (wordCounts.get(w) || 0) + 1));
  });

  let best = members[0];
  let bestScore = -1;
  members.forEach(m => {
    const tokens = tokenize(m.content);
    const score = tokens.reduce((sum, t) => sum + (wordCounts.get(t) || 0), 0) / Math.max(tokens.length, 1);
    if (score > bestScore) {
      bestScore = score;
      best = m;
    }
  });
  return best.content;
}
