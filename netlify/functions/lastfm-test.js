export async function handler(event) {
  const apiKey = process.env.LASTFM_API_KEY;
  const user = "IAMMARCUS3";

  try {
    // Determine last static week (from archive)
    const LAST_STATIC_WEEK = 396;

    // Figure out what week number we’re generating now
    // Example: 397, 398, …
    const week = LAST_STATIC_WEEK + 1;

    // Fetch Last.fm weekly chart
    const url = `http://ws.audioscrobbler.com/2.0/?method=user.getWeeklyTrackChart&user=${user}&api_key=${apiKey}&format=json&limit=100`;
    const res = await fetch(url);
    const data = await res.json();

    const tracks = data.weeklytrackchart?.track || [];

    // Convert into your weekData format
    const weekEntry = tracks.map((t, i) => ({
      rank: i + 1,
      movement: "NEW",   // later: compare with week 396
      title: t.name,
      artist: t.artist["#text"],
      album: "Unknown",
      plays: parseFloat(t.playcount),
      sales: 0,
      totalSales: 0,
      weeks: 1,
      peak: i + 1,
      streams: 0,
      radio: 0,
      points: parseInt(t.playcount)
    }));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/javascript" },
      body: `weekData["${week}"] = ${JSON.stringify(weekEntry, null, 2)};`
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
