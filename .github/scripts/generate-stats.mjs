// Builds the profile stat cards (assets/*.svg) from the GitHub GraphQL API.
// Runs in GitHub Actions, so the README never depends on a third-party image service.
import { writeFile, mkdir } from "node:fs/promises";

const LOGIN = process.env.GH_LOGIN || "rahulcs754";
const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) throw new Error("GITHUB_TOKEN is required");

async function gql(query, variables = {}) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

const { user } = await gql(
  `query($login: String!) {
    user(login: $login) {
      createdAt
      followers { totalCount }
      pullRequests { totalCount }
      issues { totalCount }
      repositories(ownerAffiliations: OWNER, isFork: false, first: 100, privacy: PUBLIC) {
        totalCount
        nodes {
          stargazerCount
          languages(first: 10, orderBy: { field: SIZE, direction: DESC }) {
            edges { size node { name color } }
          }
        }
      }
      contributionsCollection { contributionYears totalCommitContributions }
    }
  }`,
  { login: LOGIN }
);

// Contribution calendar for every year, for totals and streaks.
const days = [];
for (const year of user.contributionsCollection.contributionYears) {
  const data = await gql(
    `query($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar { weeks { contributionDays { date contributionCount } } }
        }
      }
    }`,
    { login: LOGIN, from: `${year}-01-01T00:00:00Z`, to: `${year}-12-31T23:59:59Z` }
  );
  for (const w of data.user.contributionsCollection.contributionCalendar.weeks)
    days.push(...w.contributionDays);
}
const today = new Date().toISOString().slice(0, 10);
const calendar = [...new Map(days.map((d) => [d.date, d.contributionCount])).entries()]
  .filter(([date]) => date <= today)
  .sort(([a], [b]) => a.localeCompare(b));

const totalContributions = calendar.reduce((s, [, c]) => s + c, 0);
let longest = 0, run = 0;
for (const [, c] of calendar) { run = c > 0 ? run + 1 : 0; longest = Math.max(longest, run); }
let current = 0;
let i = calendar.length - 1;
if (i >= 0 && calendar[i][1] === 0) i--; // today not counted yet is fine
for (; i >= 0 && calendar[i][1] > 0; i--) current++;

const stars = user.repositories.nodes.reduce((s, r) => s + r.stargazerCount, 0);
const langs = new Map();
for (const r of user.repositories.nodes)
  for (const e of r.languages.edges) {
    const prev = langs.get(e.node.name) || { size: 0, color: e.node.color || "#8b949e" };
    prev.size += e.size;
    langs.set(e.node.name, prev);
  }
const topLangs = [...langs.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 6);
const langTotal = topLangs.reduce((s, [, l]) => s + l.size, 0) || 1;

// ---------- SVG rendering ----------
const C = { bg: "#0d1117", border: "#30363d", title: "#a78bfa", text: "#c9d1d9", muted: "#8b949e", accent: "#7c6cff" };
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const fmt = (n) => n.toLocaleString("en-US");
const card = (w, h, title, body) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<style>text{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif}</style>
<rect x="0.5" y="0.5" width="${w - 1}" height="${h - 1}" rx="10" fill="${C.bg}" stroke="${C.border}"/>
<text x="24" y="36" font-size="17" font-weight="600" fill="${C.title}">${esc(title)}</text>
${body}
</svg>
`;

const rows = [
  ["Total stars", stars],
  ["Commits (this year)", user.contributionsCollection.totalCommitContributions],
  ["Pull requests", user.pullRequests.totalCount],
  ["Issues", user.issues.totalCount],
  ["Public repos", user.repositories.totalCount],
  ["Followers", user.followers.totalCount],
];
const statsSvg = card(420, 220, "GitHub Stats",
  rows.map(([k, v], n) =>
    `<text x="24" y="${70 + n * 25}" font-size="14" fill="${C.text}">${k}</text>` +
    `<text x="396" y="${70 + n * 25}" font-size="14" font-weight="600" fill="${C.text}" text-anchor="end">${fmt(v)}</text>`
  ).join("\n"));

let x = 24;
const bar = topLangs.map(([, l]) => {
  const w = (l.size / langTotal) * 372;
  const r = `<rect x="${x.toFixed(2)}" y="54" width="${w.toFixed(2)}" height="10" fill="${l.color}"/>`;
  x += w; return r;
}).join("");
const langSvg = card(420, 220, "Top Languages",
  `<clipPath id="c"><rect x="24" y="54" width="372" height="10" rx="5"/></clipPath><g clip-path="url(#c)">${bar}</g>\n` +
  topLangs.map(([name, l], n) => {
    const cx = 24 + (n % 2) * 190, cy = 96 + Math.floor(n / 2) * 30;
    return `<circle cx="${cx + 6}" cy="${cy - 5}" r="6" fill="${l.color}"/>` +
      `<text x="${cx + 20}" y="${cy}" font-size="14" fill="${C.text}">${esc(name)} <tspan fill="${C.muted}">${((l.size / langTotal) * 100).toFixed(1)}%</tspan></text>`;
  }).join("\n"));

const since = new Date(calendar[0]?.[0] || user.createdAt).toLocaleDateString("en-US", { month: "short", year: "numeric" });
const col = (cx, value, label, sub, big) =>
  `<text x="${cx}" y="${big ? 112 : 108}" font-size="${big ? 34 : 28}" font-weight="700" fill="${big ? C.accent : C.text}" text-anchor="middle">${fmt(value)}</text>` +
  `<text x="${cx}" y="142" font-size="14" fill="${C.text}" text-anchor="middle">${label}</text>` +
  `<text x="${cx}" y="164" font-size="12" fill="${C.muted}" text-anchor="middle">${sub}</text>`;
const streakSvg = card(420, 220, "Contribution Streak",
  `<line x1="147" y1="64" x2="147" y2="180" stroke="${C.border}"/><line x1="273" y1="64" x2="273" y2="180" stroke="${C.border}"/>\n` +
  col(84, totalContributions, "Contributions", `since ${since}`) + "\n" +
  col(210, current, "Current streak", "days", true) + "\n" +
  col(336, longest, "Longest streak", "days") +
  `\n<text x="396" y="206" font-size="10" fill="${C.muted}" text-anchor="end">Updated ${today}</text>`);

await mkdir("assets", { recursive: true });
await writeFile("assets/stats.svg", statsSvg);
await writeFile("assets/top-langs.svg", langSvg);
await writeFile("assets/streak.svg", streakSvg);
console.log({ stars, totalContributions, current, longest, langs: topLangs.map(([n]) => n) });
