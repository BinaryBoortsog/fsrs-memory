const fetch = global.fetch || require('node-fetch');

async function summarizeProject(projectMems) {
  // If no API key is configured, return a safe mock summary so tests and CI can run offline.
  if (!process.env.ANTHROPIC_API_KEY) {
    return `BRIEF: ${Array.isArray(projectMems) ? projectMems.length : 0} items.`;
  }
  const prompt = `Summarize the following project memories into a concise 3-sentence project brief:\n\n${projectMems.map(m=>`- ${m.fact}`).join("\n")}`;
  const res = await fetch("https://api.anthropic.com/v1/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": process.env.ANTHROPIC_API_KEY },
    body: JSON.stringify({ model: "claude-2", prompt, max_tokens: 300 })
  });
  const data = await res.json();
  return data?.completion || data?.text || JSON.stringify(data);
}

module.exports = { summarizeProject };
