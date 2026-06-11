/* Tally Web Cloud — Supabase credentials
   Get these from: Supabase Dashboard > Project Settings > API
   SUPABASE_URL      = Project URL
   SUPABASE_ANON_KEY = anon / public key  (safe to expose in frontend)

   APP_PIN = simple 4-digit PIN shown on the login screen.
             Anyone who knows the PIN and URL can access the data.
             Set to "" to disable the PIN and open the app directly. */

window.TALLY_CONFIG = {
  SUPABASE_URL:      "https://orsosssoxcyylncvgvnb.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9yc29zc3NveGN5eWxuY3Zndm5iIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyNDAyODcsImV4cCI6MjA5NTgxNjI4N30.QtQoDQPYlRPYeaVOB5F9Z0IKRPNCwmBxkLMoRqD5nK4",
  APP_PIN:           "1234",
};
