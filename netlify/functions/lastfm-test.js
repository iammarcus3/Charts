// netlify/functions/weekdata.js
export async function handler(event) {
  const apiKey = process.env.LASTFM_API_KEY;
  const user = "IAMMARCUS3";

  try {
    // Fetch latest weekly chart
    const chartUrl = `http://ws.audioscrobbler.com/2.0/?method=user.getWeeklyTrackChart&user=${user}&api_key=${apiKey}&format=json&limit=100`;
    const res = await fetch(chartUrl);
    const data = await res.json();

    const tracks = data.weeklytrackchart.track || [];

    const weekData = { "1": [] };

    tracks.forEach((t, i) => {
      weekData["1"].push({
        rank: i + 1,
        movement: "NEW", // later: compare with previous week
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
      });
    });

    // Respond with valid JS code so the browser can load it
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/javascript" },
      body: "const weekData = " + JSON.stringify(weekData, null, 2) + ";"
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
