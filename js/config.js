// Account and sync settings. Leave both empty to run without accounts.
// These two values are meant to be public: the publishable key only lets a
// signed-in user reach their own row (see supabase/setup.sql). Never put a
// "service_role" or "secret" key here.
export const SUPABASE_URL = "https://rdoyjipdxqvoadbytbji.supabase.co";
export const SUPABASE_KEY = "sb_publishable_v6ykF_VAZH0DpqOzUVBqCg_37EBqB0T";

// Email sign-in sends a link through Supabase's built-in mail sender, which
// only delivers to the project's own team. Turn this on once a mail service
// (custom SMTP) is connected in Supabase.
export const EMAIL_SIGN_IN = false;
