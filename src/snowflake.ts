type SnowflakeJSONv2 = {
  data?: any[][];
  code?: string;
  message?: string;
};

function escLike(s: string) {
  // escape % and _ for LIKE
  return s.replace(/[%_]/g, (m) => "\\" + m);
}

export async function lookupResources(opts: {
  accountUrl: string; // e.g. https://mm51262.canada-central.azure.snowflakecomputing.com
  pat: string; // PAT secret
  database: string;
  schema: string;
  table: string;
  warehouse?: string;
  role?: string;

  query: string;
  locationHint?: string;
  top_k?: number;
}) {
  if (!opts.accountUrl || !opts.pat) return "";

  const topK = opts.top_k ?? 3;
  const q = opts.query?.trim() || "";
  const loc = (opts.locationHint || "").trim();

  const likeQ = `%${escLike(q)}%`;
  const likeLoc = loc ? `%${escLike(loc)}%` : null;

  const fqTable = `${opts.database}.${opts.schema}.${opts.table}`;

  const statement = `
    SELECT TITLE, CITY, PHONE, URL, NOTE
    FROM ${fqTable}
    WHERE
      (NOTE ILIKE ? ESCAPE '\\\\'
       OR TITLE ILIKE ? ESCAPE '\\\\'
       OR CITY ILIKE ? ESCAPE '\\\\')
      ${loc ? "OR CITY ILIKE ? ESCAPE '\\\\'" : ""}
    LIMIT ${topK};
  `;

  const binds = loc ? [likeQ, likeQ, likeQ, likeLoc] : [likeQ, likeQ, likeQ];

  const body: any = {
    statement,
    timeout: 30,
    resultSetMetaData: { format: "json" },
    bindings: Object.fromEntries(
      binds.map((v, i) => [String(i + 1), { type: "TEXT", value: v }])
    )
  };

  if (opts.warehouse) body.warehouse = opts.warehouse;
  if (opts.role) body.role = opts.role;

  const url = `${opts.accountUrl.replace(/\/$/, "")}/api/v2/statements`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${opts.pat}`,
      "x-snowflake-authorization-token-type": "PROGRAMMATIC_ACCESS_TOKEN"
    },
    body: JSON.stringify(body)
  });

  if (!res.ok) {
    const t = await res.text();
    console.error("Snowflake HTTP error", res.status, t);
    throw new Error(`Snowflake HTTP ${res.status}: ${t}`);
  }

  const json = (await res.json()) as SnowflakeJSONv2;

  // Snowflake may return code/message even on success (e.g., 090001).
  // Only treat non-090001 codes as errors.
  if (json.code && json.code !== "090001") {
    console.error("Snowflake API error", json.code, json.message);
    throw new Error(`Snowflake API error ${json.code}: ${json.message}`);
  }

  const rows = json.data ?? [];
  if (!rows.length) return "";

  return rows
    .slice(0, topK)
    .map((r) => {
      const [title, city, phone, url, note] = r;
      const parts: string[] = [];
      if (title) parts.push(String(title));
      if (city) parts.push(`City: ${city}`);
      if (phone) parts.push(`Phone: ${phone}`);
      if (url) parts.push(`Link: ${url}`);
      if (note) parts.push(String(note));
      return "- " + parts.join(" | ");
    })
    .join("\n");
}