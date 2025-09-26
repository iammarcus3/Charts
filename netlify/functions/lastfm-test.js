// netlify/functions/lastfm-test.js

export async function handler(event) {
  // 🔑 Get your API key from Netlify environment variables
  const apiKey = process.env.LASTFM_API_KEY;

  // 🧑 Replace "YOUR_USERNAME" with your Last.fm username
  const user = "IAMMARCUS";

  // 📡 Build the Last.fm API URL (get top 5 tracks all-time)
  const url = `https://ws.audioscrobbler.com/2.0/?method=user.getTopTracks&user=${user}&api_key=${apiKey}&format=json&limit=5`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // ✅ Return the data so you can see it in browser
    return {
      statusCode: 200,
      body: JSON.stringify(data, null, 2), // pretty JSON
      headers: { "Content-Type": "application/json" }
    };
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message })
    };
  }
}
