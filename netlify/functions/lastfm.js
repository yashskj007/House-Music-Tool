exports.handler = async (event) => {
    try {
        const params = new URLSearchParams(event.queryStringParameters || {});
        params.set('api_key', process.env.LASTFM_API_KEY);
        params.set('format', 'json');

        const res = await fetch(`https://ws.audioscrobbler.com/2.0/?${params.toString()}`);
        const data = await res.json();

        return {
            statusCode: res.status,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };
    } catch (err) {
        return {
            statusCode: 500,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message }),
        };
    }
};
