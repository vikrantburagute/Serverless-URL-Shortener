const $ = (id) => document.getElementById(id);

$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("error").textContent = "";
  $("result").hidden = true;
  $("submit").disabled = true;

  try {
    const res = await fetch("/api/shorten", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: $("url").value, alias: $("alias").value }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Something went wrong");

    $("short").href = $("short").textContent = data.shortUrl;
    $("stats-link").href = data.statsUrl;
    $("result").hidden = false;
  } catch (err) {
    $("error").textContent = err.message;
  } finally {
    $("submit").disabled = false;
  }
});

$("copy").addEventListener("click", async (e) => {
  await navigator.clipboard.writeText($("short").textContent);
  e.target.textContent = "Copied!";
  setTimeout(() => (e.target.textContent = "Copy"), 1500);
});
