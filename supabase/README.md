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

The site asks visitors before collecting optional analytics. If they accept, Ilta stores a random per-tab session ID and event-link click labels. Analytics does not store visitor names, IP addresses, social profiles, or full destination URLs. Separately, authorised organiser account labels and event post links are retained for moderation and source attribution. The admin page counts active sessions seen in the last five minutes and receives Supabase Realtime updates. These are browser sessions, not verified unique people.

RLS policies keep analytics rows readable only by authorized admins. Public clients can only call the narrow heartbeat and click-recording functions; they cannot read the analytics tables.

## Organiser events and authorised social accounts

Ilta combines Helsinki Linked Events with reviewed organiser submissions and approved events from connected social accounts. Run `events-social.sql` after `schema.sql` to create the public approved-event feed and the private moderation queues. The homepage's submission form accepts organiser event details and sends them to the pending queue; only an administrator can publish them.

Social account posts are imported as **draft candidates**, never published as confirmed events automatically. An administrator must verify the date, venue, price, flyer rights and official event URL before selecting **Verify & publish**. The account's original post link remains attached as the source.

The social sync is a Supabase Edge Function. Deploy it from this folder's parent directory:

```sh
supabase functions deploy sync-social-sources --project-ref YOUR_PROJECT_REF
```

Configure secrets with values from your own approved developer apps. These are examples of the JSON shape, not working credentials:

```json
[
  {
    "provider": "instagram",
    "accountId": "PROFESSIONAL_INSTAGRAM_USER_ID",
    "displayName": "Organiser name",
    "accessToken": "SERVER_SIDE_ACCESS_TOKEN"
  },
  {
    "provider": "facebook",
    "accountId": "FACEBOOK_PAGE_ID",
    "displayName": "Organiser name",
    "accessToken": "SERVER_SIDE_PAGE_ACCESS_TOKEN"
  }
]
```

Store Instagram/Facebook entries in the `ILTA_META_ACCOUNTS` Supabase Edge Function secret and TikTok entries (the same shape with `"provider": "tiktok"`) in `ILTA_TIKTOK_ACCOUNTS`. Add those secrets and `META_GRAPH_API_VERSION` through **Supabase Dashboard → Edge Functions → Secrets**. Replace every example value with values from the approved apps; the Graph API version must be numeric and enabled for your Meta app. Do not put tokens in `supabase-config.js`, command history, source control, or chat.

- **Instagram:** the Meta API supports professional Business/Creator accounts authorised for the app, not arbitrary consumer accounts. The account must meet Meta's account/linking and permission requirements.
- **Facebook:** connect Pages the Meta app is authorised to read; this does not search all public Facebook events or personal profiles.
- **TikTok:** the account owner must authorise a TikTok developer app approved for Login Kit and Display API with `user.info.basic` and `video.list`. The API returns recent videos from that authorised user, not a city-wide event search.
- Tokens can expire or be revoked. Re-authorise/rotate them in the Supabase Edge Function secrets when required, then run **Sync accounts** in the admin dashboard to check access and import recent posts.

To poll configured accounts every 15 minutes, enable Supabase `pg_cron`, `pg_net`, and Vault; create a random secret named `ilta-scheduler-secret` in Vault and set the same value as the Edge Function secret `ILTA_SCHEDULER_SECRET` through the Supabase dashboard. Replace `YOUR_PROJECT_REF` in [`social-sync-schedule.sql`](./social-sync-schedule.sql), then run that SQL once. The function validates the scheduler secret or an authenticated Ilta administrator before syncing. The public Helsinki feed itself refreshes every five minutes; neither source is a guaranteed instant/global social-media feed.

The provider APIs and permissions change over time. Ilta does not scrape social sites, bypass logins, or claim coverage beyond the connected organiser accounts and published Helsinki listings. Check each platform's current developer terms and obtain organiser consent before connecting an account.
