import { createClient } from "@supabase/supabase-js";

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
  { 
    db: { schema: "public" },
    auth: {
      detectSessionInUrl: true,
      persistSession: true,
      autoRefreshToken: true,
    }
  }
);