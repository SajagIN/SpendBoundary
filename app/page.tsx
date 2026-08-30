import Dashboard from "@/components/Dashboard";

export const dynamic = "force-dynamic";

export default function Page() {
  // The absolute project path is only knowable on the server; the MCP guide
  // needs it to render a copy-pasteable claude_desktop_config.json.
  return <Dashboard projectPath={process.cwd()} />;
}
