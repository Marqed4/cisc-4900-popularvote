# Stage 1: build the Vite frontend
FROM node:22-alpine AS frontend
WORKDIR /app/src/frontend
COPY src/frontend/package*.json ./
RUN npm ci
COPY src/frontend/ ./
# Vite inlines these at build time
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY
ARG VITE_API_URL=""
ARG VITE_SITE_URL
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL \
    VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY \
    VITE_API_URL=$VITE_API_URL \
    VITE_SITE_URL=$VITE_SITE_URL
RUN npm run build

# Stage 2: Flask backend, also serves the built frontend from src/frontend/dist
FROM python:3.12-slim
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PORT=2167
COPY src/backend/requirements.txt src/backend/requirements.txt
RUN pip install --no-cache-dir -r src/backend/requirements.txt
COPY src/backend src/backend
COPY --from=frontend /app/src/frontend/dist src/frontend/dist
EXPOSE 2167
# Single eventlet worker: Socket.IO state is held in memory by SessionManager
CMD ["sh", "-c", "gunicorn -k eventlet -w 1 -b 0.0.0.0:${PORT} src.backend.app:app"]
