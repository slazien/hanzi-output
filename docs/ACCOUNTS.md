# Setting up accounts and sync

Accounts are optional and off until a Supabase project is connected. With them on, people can sign in with Google or a link sent by email, and their progress is saved to their account and kept in step across devices. API keys are never uploaded.

All of this can be done in a browser. Menu names in the Supabase and Google consoles change from time to time; the names below are the ones in their documentation at the time of writing.

## 1. Create the Supabase project

1. Sign up at https://supabase.com and create a new project (free plan). Pick a region near you and save the database password somewhere safe.
2. Open **SQL Editor → New query**, paste the whole of [`supabase/setup.sql`](../supabase/setup.sql) and press **Run**. This creates one table and the rules that let each signed-in user reach only their own row.
3. Open **Authentication → URL Configuration**. Set **Site URL** to `https://slazien.github.io/hanzi-output/` and add the same address under **Redirect URLs**.

## 2. Email sign-in

Nothing to set up for the project owner. Supabase's default email contains a sign-in link, which the app accepts. The link must be opened in the browser where the app is used; if the mail app opens another browser, copy the link and paste it into the right one.

Supabase's built-in sender is limited (a couple of messages an hour, and only to addresses that belong to the project's team). For other people, add an email service under **Authentication → Emails → SMTP Settings**. With custom SMTP the email template can also be edited to include a 6-digit code (`{{ .Token }}`), which the app accepts too.

## 3. Google sign-in

1. In Google Cloud (https://console.cloud.google.com), create a project, then under **Google Auth Platform** fill in the branding and audience screens.
2. Create an **OAuth client** of type **Web application**:
   - Authorized JavaScript origin: `https://slazien.github.io`
   - Authorized redirect URI: `https://<your-project-ref>.supabase.co/auth/v1/callback` (Supabase shows the exact address on its Google provider page)
3. In Supabase, open **Authentication → Sign In / Providers → Google**, turn it on and paste the client ID and client secret.

## 4. Connect the app

1. In Supabase, open **Project Settings → API** (or **API Keys**) and copy the **Project URL** and the **publishable** key (older projects call it the `anon` key).
2. Put both into [`js/config.js`](../js/config.js) and publish. These two values are meant to be public. Never use the `service_role` or `secret` key.

An **Account** section then appears at the top of Settings.

## Things to know

- Free Supabase projects pause after about a week without activity and are restored from the dashboard. Nothing is lost on a device while the project is paused; sync resumes afterwards.
- Signing in combines what is on the device with the account: attempts and history from both are kept, each review sentence keeps its most recently reviewed copy, and the most recently changed settings win.
- Sign in with Apple is not set up. It needs a paid Apple Developer membership.
