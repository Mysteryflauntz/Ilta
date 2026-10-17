# Ilta Supabase setup

The public event site continues to work without Supabase. Admin metrics and optional anonymous analytics are enabled only after Supabase is configured.

1. Create a Supabase project and run [`schema.sql`](./schema.sql) in the project SQL editor.
2. In Supabase Authentication, enable email/password sign-in and create an admin account.
3. Find that account's user UUID in the Supabase dashboard, then authorize it:

   ```sql
   insert into public.ilta_admins (user_id)
   values ('YOUR_AUTH_USER_UUID');
   ```

4. Put the project's **Project URL** and **publishable/anon key** in `supabase-config.js`. The anon key is designed to be public in browser apps; never put the service-role key in this file.
5. Open `admin.html` and sign in with the authorized account.

The site asks visitors before collecting optional analytics. If they accept, Ilta stores a random per-tab session ID and event-link click labels. It does not store names, IP addresses, social profiles, or full destination URLs. The admin page counts active sessions seen in the last five minutes and receives Supabase Realtime updates. These are browser sessions, not verified unique people.

RLS policies keep analytics rows readable only by authorized admins. Public clients can only call the narrow heartbeat and click-recording functions; they cannot read the analytics tables.

Instagram, TikTok, Facebook, Snapchat, and Google event-search integrations are not configured. Public event search or story scraping is not an available substitute for each platform's approved API access. Add any future integrations server-side with the required platform approvals and credentials; do not put provider secrets or the Supabase service-role key in browser code.
