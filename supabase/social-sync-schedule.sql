select cron.schedule(
  'ilta-social-account-sync',
  '*/15 * * * *',
  $job$
    select net.http_post(
      url := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/sync-social-sources',
      headers := jsonb_build_object(
        'Content-Type', 'application/json',
        'x-ilta-scheduler-secret',
        (select decrypted_secret
         from vault.decrypted_secrets
         where name = 'ilta-scheduler-secret')
      ),
      body := '{}'::jsonb
    );
  $job$
);
