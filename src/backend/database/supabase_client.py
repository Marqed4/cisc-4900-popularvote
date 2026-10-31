import os
from pathlib import Path
from dotenv import load_dotenv
from supabase import create_client, Client

# reads src/backend/.env, one folder up. override=True so the .env wins over whatever a
# stray shell variable thinks it knows.
load_dotenv(Path(__file__).resolve().parents[1] / '.env', override=True)

# this is the service role key, it skips every access rule. keep it here on the server
# and never in the frontend, no matter how tired you are.
supabase: Client = create_client(
    os.environ.get('SUPABASE_URL'),
    os.environ.get('SUPABASE_SERVICE_ROLE_KEY'),
)
