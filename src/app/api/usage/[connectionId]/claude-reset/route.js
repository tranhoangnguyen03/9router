// Legacy OAuth rows are retained, but the local SDK never uses their tokens.
export async function POST() {
  return Response.json({ error: "Claude Code now manages subscription usage locally. Use Claude Code to manage limit resets." }, { status: 410 });
}
