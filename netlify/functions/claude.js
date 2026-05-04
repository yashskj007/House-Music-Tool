export default async (req) => {
    if (req.method !== 'POST') {
        return new Response('Method Not Allowed', { status: 405 });
    }

    let body;
    try { body = await req.json(); } catch {
        return new Response('Bad Request', { status: 400 });
    }

    console.log('[claude] model:', body.model, 'max_tokens:', body.max_tokens,
        'system_len:', body.system?.length, 'msg_len:', body.messages?.[0]?.content?.length);

    const upstreamBody = {
        model: body.model || 'claude-sonnet-4-6',
        max_tokens: body.max_tokens || 2000,
        system: body.system,
        messages: body.messages,
        stream: true,
    };

    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': process.env.ANTHROPIC_API_KEY,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(upstreamBody),
    });

    console.log('[claude] upstream status:', upstream.status,
        'content-type:', upstream.headers.get('content-type'));

    if (!upstream.ok) {
        const err = await upstream.json().catch(() => ({}));
        console.error('[claude] upstream error:', JSON.stringify(err));
        return new Response(
            JSON.stringify({ error: err.error || { message: `Upstream error ${upstream.status}` } }),
            { status: upstream.status, headers: { 'Content-Type': 'application/json' } }
        );
    }

    // Pipe SSE stream directly to browser — keeps connection alive past 10s limit
    const { readable, writable } = new TransformStream();
    upstream.body.pipeTo(writable);

    return new Response(readable, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no',
        },
    });
};

export const config = { path: '/api/claude' };
