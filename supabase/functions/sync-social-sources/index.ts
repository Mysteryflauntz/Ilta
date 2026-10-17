import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Provider = "instagram" | "facebook" | "tiktok";

type SocialAccount = {
  provider: Provider;
  accountId: string;
  displayName: string;
  accessToken: string;
};

type Candidate = {
  provider: Provider;
  provider_post_id: string;
  source_name: string;
  post_text: string;
  post_url: string;
  image_url: string | null;
  posted_at: string | null;
  status: "pending";
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function readAccounts(secretName: string, provider: Provider): SocialAccount[] {
  const raw = Deno.env.get(secretName);
  if (!raw) return [];

  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error(`${secretName} must be a JSON array`);
  return parsed.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`${secretName} entry ${index + 1} is invalid`);
    const account = item as Record<string, unknown>;
    if (
      account.provider !== provider ||
      typeof account.accountId !== "string" ||
      typeof account.displayName !== "string" ||
      typeof account.accessToken !== "string"
    ) {
      throw new Error(`${secretName} entry ${index + 1} needs provider, accountId, displayName, and accessToken`);
    }
    return account as SocialAccount;
  });
}

function safeHttpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function toCandidate(
  account: SocialAccount,
  post: Record<string, unknown>,
): Candidate | null {
  const postId = String(post.id || "");
  const url = safeHttpsUrl(post.permalink || post.permalink_url || post.share_url);
  if (!postId || !url) return null;

  const text = [
    post.caption,
    post.message,
    post.title,
    post.video_description,
  ].find((value) => typeof value === "string");
  const image = safeHttpsUrl(post.media_url || post.full_picture || post.thumbnail_url || post.cover_image_url);
  const timestamp = post.timestamp || post.created_time || post.create_time;
  const parsedTimestamp = typeof timestamp === "number"
    ? new Date(timestamp * 1000)
    : new Date(String(timestamp || ""));

  return {
    provider: account.provider,
    provider_post_id: postId,
    source_name: account.displayName.slice(0, 160),
    post_text: typeof text === "string" ? text.slice(0, 12_000) : "",
    post_url: url,
    image_url: image,
    posted_at: Number.isNaN(parsedTimestamp.getTime()) ? null : parsedTimestamp.toISOString(),
    status: "pending",
  };
}

async function fetchAccountPosts(account: SocialAccount): Promise<Record<string, unknown>[]> {
  if (account.provider === "tiktok") {
    const url = new URL("https://open.tiktokapis.com/v2/video/list/");
    url.searchParams.set("fields", "id,title,video_description,cover_image_url,share_url,create_time");
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${account.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ max_count: 20 }),
    });
    if (!response.ok) throw new Error(`TikTok returned HTTP ${response.status}`);
    const payload = await response.json();
    if (payload.error?.code && payload.error.code !== "ok") {
      throw new Error(`TikTok API error: ${payload.error.code}`);
    }
    return Array.isArray(payload.data?.videos) ? payload.data.videos : [];
  }

  const version = Deno.env.get("META_GRAPH_API_VERSION");
  if (!version || !/^v\d+\.\d+$/.test(version)) {
    throw new Error("Set META_GRAPH_API_VERSION to the Graph API version enabled for your Meta app");
  }
  const fields = account.provider === "instagram"
    ? "id,caption,media_type,media_url,permalink,timestamp,thumbnail_url"
    : "id,message,permalink_url,created_time,full_picture";
  const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(account.accountId)}/${account.provider === "instagram" ? "media" : "posts"}`);
  url.searchParams.set("fields", fields);
  url.searchParams.set("limit", "25");
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${account.accessToken}` },
  });
  if (!response.ok) throw new Error(`Meta returned HTTP ${response.status}`);
  const payload = await response.json();
  if (payload.error?.message) throw new Error(`Meta API error: ${payload.error.message}`);
  return Array.isArray(payload.data) ? payload.data : [];
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return jsonResponse(405, { error: "Use POST to sync connected event accounts." });

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) {
    return jsonResponse(503, { error: "The server-side Supabase function is not fully configured." });
  }

  const authorization = request.headers.get("Authorization");
  if (!authorization) return jsonResponse(401, { error: "Administrator sign-in is required." });
  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: authData, error: authError } = await userClient.auth.getUser();
  if (authError || !authData.user) return jsonResponse(401, { error: "Administrator sign-in is required." });
  const { data: admin, error: adminError } = await userClient
    .from("ilta_admins")
    .select("user_id")
    .eq("user_id", authData.user.id)
    .maybeSingle();
  if (adminError || !admin) return jsonResponse(403, { error: "Only Ilta administrators can sync event accounts." });

  let accounts: SocialAccount[];
  try {
    accounts = [
      ...readAccounts("ILTA_META_ACCOUNTS", "instagram"),
      ...readAccounts("ILTA_META_ACCOUNTS", "facebook"),
      ...readAccounts("ILTA_TIKTOK_ACCOUNTS", "tiktok"),
    ];
  } catch (error) {
    return jsonResponse(503, { error: error instanceof Error ? error.message : "Social account configuration is invalid." });
  }

  if (!accounts.length) {
    return jsonResponse(200, {
      message: "No authorised social accounts are configured yet.",
      imported: 0,
      results: [],
    });
  }

  const serviceClient = createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const results = await Promise.all(accounts.map(async (account) => {
    try {
      const posts = await fetchAccountPosts(account);
      const candidates = posts
        .map((post) => toCandidate(account, post))
        .filter((candidate): candidate is Candidate => candidate !== null);
      if (candidates.length) {
        const { error } = await serviceClient
          .from("ilta_social_candidates")
          .upsert(candidates, { onConflict: "provider,provider_post_id", ignoreDuplicates: true });
        if (error) throw new Error(`Could not save imported posts: ${error.message}`);
      }
      return { provider: account.provider, account: account.displayName, imported: candidates.length };
    } catch (error) {
      console.error(`Social sync failed for ${account.provider} account ${account.displayName}:`, error);
      return {
        provider: account.provider,
        account: account.displayName,
        imported: 0,
        error: error instanceof Error ? error.message : "Social account sync failed.",
      };
    }
  }));

  return jsonResponse(200, {
    imported: results.reduce((sum, result) => sum + result.imported, 0),
    results,
  });
});
