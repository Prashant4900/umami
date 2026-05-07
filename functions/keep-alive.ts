import { createClient } from "https://esm.sh/@supabase/supabase-js@2.75.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface FetchNewsConfig {
  id: string;
  name: string;
  rest_api: string;
  method: string;
  query: string | null;
  country: string | null;
  api_key: string | null;
  cron: string | null;
  is_enabled: boolean;
  last_fetched_at: string | null;
}

// Match a single cron field against current value
function matchesCronField(
  value: number,
  pattern: string,
  min: number,
  max: number,
): boolean {
  // * means any value
  if (pattern === "*") {
    return true;
  }

  // Specific number: "5"
  if (/^\d+$/.test(pattern)) {
    return value === parseInt(pattern);
  }

  // Range: "1-5"
  if (/^\d+-\d+$/.test(pattern)) {
    const [start, end] = pattern.split("-").map(Number);
    return value >= start && value <= end;
  }

  // Step: "*/5" or "1-31/2"
  if (pattern.includes("/")) {
    const [range, step] = pattern.split("/");
    const stepNum = parseInt(step);

    if (range === "*") {
      // */5 means every 5 units starting from min
      return (value - min) % stepNum === 0;
    } else if (range.includes("-")) {
      // 1-31/2 means every 2 units in range 1-31
      const [start, end] = range.split("-").map(Number);
      if (value < start || value > end) {
        return false;
      }
      return (value - start) % stepNum === 0;
    }
  }

  // List: "1,15,30"
  if (pattern.includes(",")) {
    const values = pattern.split(",").map(Number);
    return values.includes(value);
  }

  console.warn(`Unsupported cron pattern: ${pattern}`);
  return false;
}

// Check if an API should be called based on its cron schedule
function shouldCallApi(config: FetchNewsConfig): boolean {
  if (!config.cron) {
    console.warn(`No cron defined for ${config.name}`);
    return false;
  }

  if (!config.last_fetched_at) {
    console.log(`${config.name} has never been fetched, allowing execution`);
    return true; // First time execution
  }

  const now = new Date();
  const lastFetched = new Date(config.last_fetched_at);

  // Parse cron: minute hour day-of-month month day-of-week
  const cronParts = config.cron.trim().split(/\s+/);

  if (cronParts.length !== 5) {
    console.error(`Invalid cron format for ${config.name}: ${config.cron}`);
    return false;
  }

  const [minutePart, hourPart, dayPart, monthPart, dowPart] = cronParts;

  try {
    // Check if the cron matches current time
    if (!matchesCronField(now.getMinutes(), minutePart, 0, 59)) {
      return false;
    }

    if (!matchesCronField(now.getHours(), hourPart, 0, 23)) {
      return false;
    }

    if (!matchesCronField(now.getDate(), dayPart, 1, 31)) {
      return false;
    }

    if (!matchesCronField(now.getMonth() + 1, monthPart, 1, 12)) {
      return false;
    }

    if (!matchesCronField(now.getDay(), dowPart, 0, 6)) {
      return false;
    }

    // Check if we already ran in this time window (within last 10 minutes)
    const timeSinceLastFetch = now.getTime() - lastFetched.getTime();
    const minutesSinceLastFetch = timeSinceLastFetch / (1000 * 60);

    if (minutesSinceLastFetch < 10) {
      console.log(
        `${config.name} was already executed ${minutesSinceLastFetch.toFixed(
          1,
        )} minutes ago, skipping`,
      );
      return false;
    }

    console.log(`${config.name} matches cron schedule and ready to execute`);
    return true;
  } catch (error) {
    console.error(`Error parsing cron for ${config.name}:`, error);
    return false;
  }
}

// Call an external API
async function callExternalApi(config: FetchNewsConfig): Promise<any> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Add API key if provided
  if (config.api_key) {
    headers["Authorization"] = `Bearer ${config.api_key}`;
  }

  let url = config.rest_api;
  let body: string | undefined;

  // Handle POST/PUT/PATCH requests with JSON body
  if (["POST", "PUT", "PATCH"].includes(config.method)) {
    const requestBody: Record<string, string> = {};
    if (config.query) requestBody.query = config.query;
    if (config.country) requestBody.country = config.country;
    body = JSON.stringify(requestBody);
    console.log(
      `Calling ${config.method} ${url} for ${config.name} with body:`,
      requestBody,
    );
  }
  // Handle GET/DELETE requests with query parameters
  else {
    if (config.query || config.country) {
      const params = new URLSearchParams();
      if (config.query) params.append("query", config.query);
      if (config.country) params.append("country", config.country);
      url += `?${params.toString()}`;
    }
    console.log(`Calling ${config.method} ${url} for ${config.name}`);
  }

  const response = await fetch(url, {
    method: config.method,
    headers,
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API call failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return await response.json();
}

Deno.serve(async (req) => {
  // Handle CORS preflight requests
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Initialize Supabase client with service role key (needed for internal tables)
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const now = new Date();
    console.log(
      `\n========== Cron Job Check at ${now.toISOString()} ==========`,
    );
    console.log(
      `Current time: ${now.toLocaleString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
        day: "2-digit",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      })} UTC`,
    );

    // Fetch all enabled API configurations
    const { data: configs, error: fetchError } = await supabase
      .from("fetch_news")
      .select("*")
      .eq("is_enabled", true);

    if (fetchError) {
      console.error("Error fetching configs:", fetchError);
      throw fetchError;
    }

    if (!configs || configs.length === 0) {
      console.log("No enabled API configurations found");
      return new Response(
        JSON.stringify({
          message: "No enabled API configurations found",
          called: 0,
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    console.log(`Found ${configs.length} enabled configurations\n`);

    const results = [];
    let calledCount = 0;

    // Process each configuration
    for (const config of configs as FetchNewsConfig[]) {
      try {
        console.log(`--- Checking ${config.name} ---`);
        console.log(`Cron: ${config.cron}`);
        console.log(`Last fetched: ${config.last_fetched_at || "Never"}`);

        // Check if this API should be called based on cron schedule
        if (!shouldCallApi(config)) {
          console.log(`⏭️  Skipping ${config.name} - not due yet\n`);
          results.push({
            name: config.name,
            status: "skipped",
            reason: "not due according to cron schedule",
            cron: config.cron,
            last_fetched_at: config.last_fetched_at,
          });
          continue;
        }

        console.log(`✅ ${config.name} is due, executing...`);

        // Call the external API
        const apiResponse = await callExternalApi(config);

        // Update last_fetched_at
        const { error: updateError } = await supabase
          .from("fetch_news")
          .update({ last_fetched_at: new Date().toISOString() })
          .eq("id", config.id);

        if (updateError) {
          console.error(
            `Error updating last_fetched_at for ${config.name}:`,
            updateError,
          );
        }

        calledCount++;
        results.push({
          name: config.name,
          status: "success",
          recordsReceived: Array.isArray(apiResponse) ? apiResponse.length : 1,
          executed_at: new Date().toISOString(),
          cron: config.cron,
        });

        console.log(`✅ Successfully called ${config.name}\n`);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        console.error(`❌ Error processing ${config.name}:`, error);
        results.push({
          name: config.name,
          status: "error",
          error: errorMessage,
          cron: config.cron,
        });
      }
    }

    const response = {
      timestamp: now.toISOString(),
      message: `Processed ${configs.length} configurations`,
      called: calledCount,
      skipped: configs.length - calledCount,
      results,
    };

    console.log("\n========== Summary ==========");
    console.log(
      `Total: ${configs.length} | Called: ${calledCount} | Skipped: ${
        configs.length - calledCount
      }`,
    );
    console.log("===============================\n");

    return new Response(JSON.stringify(response), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    console.error("Error in call-scheduled-apis function:", error);
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
