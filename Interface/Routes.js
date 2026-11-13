(() => {
    // The bundled CI frontend and locally built backend use different Leptos
    // server function hashes. Translate only known functions at the local origin.
    const origin = "http://127.0.0.1:18784";
    if (location.origin !== origin) return;
    const noms = new Set([
        "begin_login", "change_device_ip", "dashboard_summary", "delete_account", "delete_app",
        "delete_device", "export_livecontainer_cert", "export_pairing", "get_device_info",
        "get_server_config", "install_ipa", "job_status", "list_account_app_ids", "list_accounts",
        "list_apps", "list_devices", "list_jobs", "poll_login", "probe_device", "reconcile_apps",
        "refresh_app", "refresh_device", "register_device", "reimport_pairing",
        "set_anisette_url", "set_refresh_enabled", "submit_two_factor",
    ]);
    const fetchOriginal = window.fetch.bind(window);
    window.fetch = async (entree, options) => {
        const url = new URL(entree instanceof Request ? entree.url : entree, document.baseURI);
        const resultat = url.origin === origin && /^\/api\/([a-z_]+)6042614608279630168$/.exec(url.pathname);
        if (!resultat || !noms.has(resultat[1])) return fetchOriginal(entree, options);
        url.pathname = "/api/" + resultat[1] + "11318273670462819093";
        if (!(entree instanceof Request)) return fetchOriginal(url, options);
        const r = new Request(entree, options);
        return fetchOriginal(url, {
            method: r.method, headers: r.headers, body: r.body ? await r.arrayBuffer() : undefined,
            mode: r.mode, credentials: r.credentials, cache: r.cache, redirect: r.redirect,
            referrer: r.referrer, referrerPolicy: r.referrerPolicy, integrity: r.integrity,
            keepalive: r.keepalive, signal: r.signal,
        });
    };
})();
