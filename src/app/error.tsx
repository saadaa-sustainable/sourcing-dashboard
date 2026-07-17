'use client';
export default function ErrorPage({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) { return <div className="page-loading"><h2>We couldn’t load sourcing data</h2><p>{error.message}</p><button className="primary-button" onClick={reset}>Try again</button></div>; }
