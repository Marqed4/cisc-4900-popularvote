// where the backend lives. one place, so "localhost" can't leak into a production build.
//
// dev: VITE_API_URL is usually empty or http://localhost:2167, and Vite proxies /api and
// /socket.io to Flask either way.
// production: the backend serves the built frontend, so same-origin ("") is the right default.
// a localhost URL baked into a production bundle can only ever be wrong for the visitor, so
// it gets ignored... a visitor's localhost is their own laptop, and nothing is listening there.
const configured = import.meta.env.VITE_API_URL ?? "";
const pointsAtLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(configured);

export const API_BASE = import.meta.env.PROD && pointsAtLocalhost ? "" : configured;

// undefined makes socket.io connect to the page's own origin, which is what production wants.
export const SOCKET_URL = API_BASE || (import.meta.env.DEV ? "http://localhost:2167" : undefined);
