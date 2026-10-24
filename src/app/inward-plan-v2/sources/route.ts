import { context, findSources, V2SignInRequired } from '@/lib/inward-plan-v2/server';

const headers = { 'Cache-Control': 'private, no-store' };

// A read-only request must not invoke a Server Action or re-render the editor.
export async function GET(request: Request) {
  try { await context(); }
  catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Access denied.' },
      { status: error instanceof V2SignInRequired ? 401 : 403, headers });
  }
  const params = new URL(request.url).searchParams;
  const field = params.get('field') ?? 'product';
  if (field !== 'product' && field !== 'variant')
    return Response.json({ error: 'Choose Product Code or Variant Code.' }, { status: 400, headers });
  try {
    return Response.json({ rows: await findSources(params.get('query') ?? '', field) }, { headers });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'Product/variant search failed.' },
      { status: 400, headers });
  }
}
