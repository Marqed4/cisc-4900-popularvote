# CISC-4900-PopularVote

## Project Overview
PopularVote is a web application enabling anonymous question submission and real-time clustering. The platform allows session hosts to gather feedback from groups, automatically organize submissions by topic using AI, and respond to aggregated questions.

## Core Functionality
The application supports several key workflows:

- **Anonymous Participation**: Users submit questions without identification, no account required
- **Automated Organization**: AI (Google Gemini) groups similar submissions into clusters
- **Host Responses**: Session leaders and promoted curators answer clustered questions collectively
- **Real-time Engagement**: Participants upvote questions and view responses live over WebSockets
- **Session Expansion & RAG Suggestions**: Hosts can upload notes (PDF) to seed suggested answers and a chat flow
- **Optional End-to-End Encryption**: Sessions can opt into per-session encryption, where submission content and clustering happen client-side and the server only relays opaque ciphertext
- **Session Export**: Results download as PDF summaries

## Technology Foundation
The repository is split into `src/frontend` and `src/backend`:

- **Frontend**: React 19 + Vite, `socket.io-client`, `@supabase/supabase-js`, QR-code session join (`html5-qrcode`/`qrcode`), PDF export (`jspdf`)
- **Backend**: Python/Flask with `Flask-SocketIO` (`eventlet`) for real-time events, `Flask-Limiter` for rate limiting, `google-genai` for clustering/chat intelligence, `pypdf` for host-notes extraction, served in production via `gunicorn`
- **Persistence**: PostgreSQL via Supabase, backing sessions, submissions, and clusters — the backend keeps an in-memory cache hydrated from and written through to the database, not the sole source of truth

The backend was originally built on Node.js/Express and later ported to Python/Flask to consolidate on a single runtime for AI/PDF tooling and WebSockets. See `documents/design_documents/` for the full design history and decision log.

## Deployment Context
The frontend deploys as a static build on Render's free tier. The backend runs separately on Railway. Because both are free/low tiers, initial requests following idle periods may experience delays during service reactivation.

## Getting Started
1. Clone the repository.
2. Copy `src/backend/.env.example` to `src/backend/.env` and fill in Supabase and Gemini credentials.
3. Copy `src/frontend/.env.example` to `src/frontend/.env` and fill in Supabase and API URL values.
4. Install backend dependencies from `src/backend/requirements.txt` and frontend dependencies via `npm install` in `src/frontend`.
5. Run the backend (`app.py`) and frontend (`npm run dev`) dev servers.

### Running with Docker
A multi-stage `Dockerfile` builds the Vite frontend and serves it from the Flask backend in one container.

1. Fill in `src/backend/.env` as above.
2. Put `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in a `.env` at the repo root. Compose passes them to the frontend build.
3. Run `docker compose up --build` and open `http://localhost:6967`.

Host port `6967` maps to container port `2167` because the CORS and Socket.IO allowlist in `src/backend/app.py` only permits `http://localhost:6967`. Keep the backend at one worker, since `SessionManager` holds session state in memory.

## Community
The project welcomes contributions and maintains a contribution guide. It operates under GPLv3 licensing with comprehensive legal documentation available under `documents/legal/` and `documents/licenses/`.
