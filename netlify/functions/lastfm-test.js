// netlify/functions/scheduled-week.js

// --- Conversion factors from your Python ---
const STREAMS_FACTORS = [1.0, 0.9, 0.8, 0.7, 0.6];
const RADIO_FACTORS   = [1.0, 1.2, 1.5, 2.0, 2.5];

// Example multipliers by rank (adjust to your Python’s exact values)
function getMultiplierForRank(rank) {
  if (rank === 1) return 2.0;
  if (rank <= 10) return 1.5;
  if (rank <= 50) return 1.2;
  return 1.0;
}

function getFactor(factors, weeks) {
  if (weeks <= factors.length) return factors[weeks - 1];
  return factors[factors.length - 1];
}

function calcSales(plays, multiplier) {
  return plays * multiplier;
}

function calcStreams(sales, weeks) {
  const factor = getFactor(STREAMS_FACTORS, weeks);
  return sales * factor * 8500;
}

function calcRadio(sales, weeks) {
  const factor = getFactor(RADIO_FACTORS, weeks);
  return sales * factor * 1_000_000;
}

function calcPoints(sales, streams, radio, maxSales, maxStreams, maxRadio) {
  const sNorm = maxSales ? sales / maxSales : 0;
  const stNorm = maxStreams ? streams / maxStreams : 0;
  const rNorm = maxRadio ? radio / maxRadio : 0;

  return Math.round(
    200 * (0.3 * sNorm + 0.3 * stNorm + 0.4 * rNorm)
  );
}

// --- Scheduled Netlify Function ---
export async function handler(event, context) {
  const apiKey = process.env.LASTFM_API_KEY;
  const user = "IAMMARCUS3"; // change this
  const LAST_STATIC_WEEK = 396;

  try {
    // Step 1: Get available weekly ranges
    const listUrl = `http://ws.audioscrobbler.com/2.0/?method=user.getWeeklyChartList&user=${user}&api_key=${apiKey}&format=json`;
    const res = await fetch(listUrl);
    const data = await res.json();
    const weeks = data.weeklychartlist.chart;

    // Step 2: Pick the most recent week
    const latest = weeks[weeks.length - 1];
    const from = latest.from;
    const to = latest.to;

    // Step 3: Fetch the chart for that range
    const chartUrl = `http://ws.audioscrobbler.com/2.0/?method=user.getWeeklyTrackChart&user=${user}&api_key=${apiKey}&format=json&from=${from}&to=${to}&limit=100`;
    const chartRes = await fetch(chartUrl);
    const chartData = await chartRes.json();
    const tracks = chartData.weeklytrackchart?.track || [];

    // Step 4: Process into weekData format
    let maxSales = 0, maxStreams = 0, maxRadio = 0;
    const weeksOnChart = 1; // new entries start at 1

    // First pass: raw values
    const enriched = tracks.map((t, i) => {
      const plays = parseFloat(t.playcount);
      const rank = i + 1;
      const multiplier = getMultiplierForRank(rank);

      const sales = calcSales(plays, multiplier);
      const streams = calcStreams(sales, weeksOnChart);
      const radio = calcRadio(sales, weeksOnChart);

      maxSales = Math.max(maxSales, sales);
      maxStreams = Math.max(maxStreams, streams);
      maxRadio = Math.max(maxRadio, radio);

      return { rank, title: t.name, artist: t.artist["#text"], plays, sales, streams, radio };
    });

    // Second pass: normalize & calculate points
    const weekEntry = enriched.map((row) => ({
      rank: row.rank,
      movement: "NEW",
      title: row.title,
      artist: row.artist,
      album: "Unknown",
      plays: row.plays,
      sales: row.sales,
      totalSales: row.sales,
      weeks: weeksOnChart,
      peak: row.rank,
      streams: row.streams,
      radio: row.radio,
      points: calcPoints(row.sales, row.streams, row.radio, maxSales, maxStreams, maxRadio)
    }));

    // Step 5: Output as JS
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/javascript" },
      body: `weekData["${LAST_STATIC_WEEK + 1}"] = ${JSON.stringify(weekEntry, null, 2)};`
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
}
