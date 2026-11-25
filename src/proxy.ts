import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Proxy (ex middleware in Next 16):
 * 1. CSP con nonce per richiesta (script e stili solo con nonce, niente inline arbitrario);
 * 2. header di sicurezza;
 * 3. refresh della sessione Supabase via cookie httpOnly.
 */
export async function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const isDev = process.env.NODE_ENV === "development";
  const isHttps = request.nextUrl.protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    `style-src 'self' 'nonce-${nonce}'`,
    // solo attributi style="" (larghezze di barre/grafici); <style> e script restano vincolati al nonce
    "style-src-attr 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(isHttps ? ["upgrade-insecure-requests"] : []),
  ].join("; ");

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", csp);

  let response = NextResponse.next({ request: { headers: requestHeaders } });

  // Modalita' manutenzione (variabile MAINTENANCE_MODE=1): pagina dedicata con 503, nessun accesso ai dati
  const maintenance = process.env.MAINTENANCE_MODE?.trim() === "1";
  if (maintenance && !request.nextUrl.pathname.startsWith("/manutenzione")) {
    response = NextResponse.rewrite(new URL("/manutenzione", request.url), { request: { headers: requestHeaders }, status: 503 });
    response.headers.set("Retry-After", "1800");
    response.headers.set("Content-Security-Policy", csp);
    response.headers.set("X-Frame-Options", "DENY");
    return response;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  if (url && key) {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (list) => {
          for (const { name, value } of list) request.cookies.set(name, value);
          response = NextResponse.next({ request: { headers: requestHeaders } });
          for (const { name, value, options } of list) response.cookies.set(name, value, options);
        },
      },
    });
    // getUser() valida il token con Supabase Auth e lo rinnova se necessario
    await supabase.auth.getUser();
  }

  response.headers.set("Content-Security-Policy", csp);
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()");
  response.headers.set("Cross-Origin-Opener-Policy", "same-origin");
  if (isHttps) response.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  return response;
}

export const config = {
  matcher: [
    // escludi asset statici e webhook/cron machine-to-machine (autenticati da segreto)
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|icons/|sw.js|offline.html|manifest.webmanifest|api/cron|api/security/ingest|api/health).*)",
  ],
};
