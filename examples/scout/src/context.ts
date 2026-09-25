// Scout is deterministic: it reads prompt_context with plain regular expressions. A real
// agent would hand prompt_context to its model unchanged.

const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

function tag(xml: string, name: string): string | undefined {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`));
  return m?.[1] === undefined ? undefined : decode(m[1]).trim();
}

export type IssueContext = {
  title?: string;
  description?: string;
  team?: string;
  labels: string[];
  project?: string;
  repositoryHints: string[];
};

export function readPromptContext(xml: string): IssueContext {
  const issue = tag(xml, "issue") ?? "";
  const description = tag(issue, "description");
  const ctx: IssueContext = {
    labels: [...issue.matchAll(/<label(?:\s[^>]*)?>([\s\S]*?)<\/label>/g)].map((m) => decode(m[1] ?? "").trim()),
    repositoryHints: [...xml.matchAll(/<repository-hint\s+repository="([^"]*)"\s*\/>/g)].map((m) => decode(m[1] ?? "")),
  };
  const title = tag(issue, "title");
  const team = tag(issue, "team");
  const project = tag(issue, "project");
  if (title) ctx.title = title;
  if (description) ctx.description = description;
  if (team) ctx.team = team;
  if (project) ctx.project = project;
  return ctx;
}
