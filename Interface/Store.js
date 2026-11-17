(() => {
    if (location.origin !== "http://127.0.0.1:18784" && !globalThis.sideRelayWebBridge) return;

    const categories = [
        ["Games", "#6558e6"], ["Emulators", "#ad60ee"],
        ["Entertainment", "#3184df"], ["Music", "#e74774"],
        ["Productivity", "#238e83"], ["Utilities", "#ca6e22"],
        ["Developer Tools", "#397acb"], ["Books & Reading", "#a9734e"],
        ["Health & Fitness", "#d9515d"], ["Lifestyle", "#278c77"],
        ["Social", "#3389a8"], ["Other", "#747784"],
    ];
    const categoryMap = new Map(categories.map(([label]) => [label.toLowerCase(), label]));
    for (const [label, keys] of [
        ["Emulators", "emulation"], ["Entertainment", "video|photo-video|photo & video"],
        ["Music", "audio"], ["Productivity", "business"], ["Utilities", "utility"],
        ["Developer Tools", "developer|developer-tools"], ["Books & Reading", "books|reading|reference"],
        ["Health & Fitness", "healthcare-fitness|health-fitness|health"], ["Social", "social-networking|social networking"],
    ]) {
        for (const key of keys.split("|")) categoryMap.set(key, label);
    }
    const assigned = new Map();
    for (const [category, bundles] of [
        ["Emulators", "com.rileytestut.delta com.provenance-emu.provenance me.oatmealdome.dolphinios-njb com.libretro.retroarchios11 org.ppsspp.ppsspp com.stik.stiknes net.nerd.inds com.virtualapplications.play com.litchie.idosgames com.adriweb.firebird-emu com.yoshisuga.activegs com.example.mame4ios org.scummvm.scummvm net.namedfork.minivmac com.jevon.pocket8 com.armsx2.ios com.provenance.ifly com.joemattiello.icube software.iridium"],
        ["Developer Tools", "app.ish.ish com.termoso.ios com.agor.agorapp app.backburner.sidecar"],
        ["Productivity", "app.folio.paperless com.neo.countdown com.rileytestut.clip"],
        ["Music", "com.juananzzz.resonus app.lokal.mobile"],
        ["Books & Reading", "app.aidoku.aidoku"], ["Health & Fitness", "com.goose.app"],
        ["Games", "eu.pokemmo.client eu.vcmi.vcmiclient"],
        ["Utilities", "com.utmapp.utm com.xitrix.itorrent2 com.zurac.oldos com.wh0ba.xpatcher thewonderofyou.feather"],
    ]) {
        for (const id of bundles.split(" ")) assigned.set(id, category);
    }
    const variants = new Map([
        ["me.oatmealdome.dolphinios-njb-patreon", "me.oatmealdome.dolphinios-njb"],
        ["com.utmapp.utm-se", "com.utmapp.utm"], ["org.provenance-emu.provenance", "com.provenance-emu.provenance"],
        ["org.ppsspp.ppsspp-free", "org.ppsspp.ppsspp"], ["org.spotube.spotube.spotube", "oss.krtirtho.spotube"],
    ]);
    const preRelease = /(?:\bbuild\b|alpha|beta|nightly|preview|canary)/i;
    const compareVersions = new Intl.Collator(undefined, { numeric: true }).compare;
    const date = value => Date.parse(value || "") || 0;
    const releases2026 = "2026 Releases";
    const is2026 = release => /^2026-\d{2}-\d{2}/.test(release.date || "") && date(release.date) <= Date.now();
    const featured = {
        ios: ["com.rileytestut.delta", "app.aidoku.aidoku", "app.lokal.mobile",
            "stream.yattee.app", "app.folio.paperless", "com.utmapp.utm"],
        tvos: ["com.gstudios.rivulet/tvos", "com.example.orbrisa/tvos", "com.xlnd47.afterburner/tvos",
            "app.molinete.aerio/tvos", "com.zanwingmak.nightfalltv/tvos", "app.marquee.marquee/tvos"],
    };

    function listingsFrom(sources) {
        const listings = new Map();
        for (const source of sources) {
            for (const app of source.apps) {
                const bundle = app.bundleId.toLowerCase();
                const stable = bundle.replace(/(?:[.-](?:beta|alpha|nightly|preview|canary))+$/g, "");
                for (const release of app.versions) {
                    const family = (variants.get(stable) || stable) + (release.platform === "tvOS" ? "/tvos" : "");
                    if (!listings.has(family)) listings.set(family, []);
                    const preview = Boolean(app.beta || stable !== bundle || preRelease.test(release.version) ||
                        /\b(?:alpha|beta|nightly|preview|canary)\b/i.test(app.name));
                    listings.get(family).push({ source, app, release, bundle, preview });
                }
            }
        }
        return [...listings].map(([id, editions]) => {
            editions.sort((a, b) => Number(Boolean(a.release.restricted)) - Number(Boolean(b.release.restricted))
                || Number(b.bundle === "com.utmapp.utm-se") - Number(a.bundle === "com.utmapp.utm-se")
                || Number(a.preview) - Number(b.preview)
                || Number(Boolean(a.source.curated)) - Number(Boolean(b.source.curated))
                || date(b.release.date) - date(a.release.date)
                || compareVersions(b.release.version, a.release.version)
                || a.source.name.localeCompare(b.source.name));
            const seen = new Set();
            const releases = editions.filter(({ bundle, release }) => {
                const key = [bundle, release.version, release.build || "", release.restricted].join("|");
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });
            const primary = releases[0];
            const category = assigned.get(id) || categoryMap.get(primary.app.category?.toLowerCase()) || "Other";
            const searchTerms = [category, ...releases.flatMap(({ app, source }) =>
                [app.name, app.developer, app.bundleId, app.subtitle, source.name])].join("\n").toLocaleLowerCase();
            return { id, primary, category, releases, searchTerms };
        }).sort((a, b) => a.primary.app.name.localeCompare(b.primary.app.name));
    }

    const nativePortal = !globalThis.sideRelayWebBridge;
    const onStorePage = () => location.pathname === "/" && location.search === "?view=store";
    const gallerySelector = ".sr-store-featured, .sr-store-preview-strip";
    let farthestStoreEntry = history.state?.sideRelayStore?.position ?? 0;
    let galleryTimer = 0;
    let previousBounds;
    function reportGalleryBounds() {
        if (!nativePortal || galleryTimer) return;
        galleryTimer = setTimeout(() => {
            galleryTimer = 0;
            if (!onStorePage()) { previousBounds = undefined; return; }
            const bounds = JSON.stringify([...document.querySelectorAll(gallerySelector)].flatMap(gallery => {
                if (gallery.scrollWidth <= gallery.clientWidth + 1) return [];
                const { x, y, width, height } = gallery.getBoundingClientRect();
                if (width <= 0 || height <= 0) return [];
                return [[x, y, width, height].map(Math.round)];
            }));
            if (bounds === previousBounds) return;
            previousBounds = bounds;
            void window.webkit.messageHandlers.signatureCompte.postMessage({ action: "storeGalleryBounds", bounds })
                .catch(() => { if (previousBounds === bounds) previousBounds = undefined; });
        }, 40);
    }
    globalThis.sideRelayAnimateHistory = direction => {
        const view = document.querySelector("main.main-content");
        if (!view || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
        view.getAnimations().find(animation => animation.id === "sideRelaySwipe")?.cancel();
        view.animate(
            [{ translate: (direction * 16) + "px 0", opacity: 0.94 }, { translate: "0px 0", opacity: 1 }],
            { id: "sideRelaySwipe", duration: 175, easing: "cubic-bezier(0.2, 0.7, 0.25, 1)" }
        );
    };
    window.addEventListener("popstate", event => {
        if (!onStorePage()) return;
        document.querySelector(".sr-store")?.dispatchEvent(new CustomEvent("sr-store-history", {
            detail: event.state?.sideRelayStore,
        }));
        if (nativePortal) {
            void window.webkit.messageHandlers.signatureCompte.postMessage({ action: "storeHistoryRestored" })
                .catch(() => {});
        }
    });
    if (nativePortal) {
        window.addEventListener("scroll", reportGalleryBounds, { passive: true });
        window.addEventListener("resize", reportGalleryBounds, { passive: true });
        globalThis.sideRelayScrollStore = (x, y) => new Promise(resolve => {
            requestAnimationFrame(() => {
                if (onStorePage() && !document.querySelector("dialog[open]")) {
                    if (y) window.scrollBy(0, y);
                    if (x) {
                        const gallery = [...document.querySelectorAll(gallerySelector)].find(item => !item.closest("[hidden]"));
                        gallery?.scrollBy(x, 0);
                    }
                }
                resolve();
            });
        });
    } else {
        globalThis.sideRelayStoreCanSwipe = direction => {
            if (!onStorePage()) return false;
            const position = history.state?.sideRelayStore?.position ?? 0;
            return direction < 0 ? position > 0 : position < farthestStoreEntry;
        };
        globalThis.sideRelaySaveStoreHistory = () => {
            if (!onStorePage() || !history.state?.sideRelayStore) return;
            document.querySelector(".sr-store")?.dispatchEvent(new Event("sr-store-save-history"));
        };
        window.addEventListener("scrollend", globalThis.sideRelaySaveStoreHistory, { passive: true });
    }

    globalThis.sideRelayStore = function ({ node, button, feedback, catalogue, formatDate, githubRetryMessage,
        prepare, review, manage, failure }) {
        const view = node("section", "", "sr-store");
        view.setAttribute("aria-label", "Store");
        const header = node("header", "", "sr-store-header");
        const heading = node("h1", "Discover");
        const leading = node("div", "", "sr-store-leading");
        const back = button("", goBack, "btn sr-store-back");
        back.hidden = true;
        leading.append(back, heading);
        const tools = node("div", "", "sr-store-toolbar");
        const search = node("input");
        search.type = "search";
        const searchField = node("label", "", "sr-store-search");
        searchField.append(search);
        const more = button("•••", async trigger => {
            if (trigger.dataset.menuOpen) return;
            const rect = trigger.getBoundingClientRect();
            trigger.dataset.menuOpen = "1";
            try {
                const action = await (globalThis.sideRelayWebBridge ?? window.webkit.messageHandlers.signatureCompte).postMessage({
                    action: "storeActions", x: String(rect.left), y: String(rect.bottom),
                });
                if (!view.isConnected) return;
                if (action === "manage") await manage(trigger);
                if (action === "refresh") await refresh(true);
            } catch (error) {
                banner.textContent = failure(error, "Could not open Store actions.");
            } finally { delete trigger.dataset.menuOpen; }
        }, "btn sr-store-more");
        more.setAttribute("aria-label", "More Store actions");
        more.setAttribute("aria-haspopup", "menu");
        more.title = "More Store actions";
        tools.append(searchField, more);
        const tabs = node("div", "", "sr-catalogue-tabs sr-store-tabs");
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", "Store platform");
        const banner = feedback();
        const sourceNotice = node("div", "", "sr-store-source-notice");
        const sourceStatus = feedback();
        sourceNotice.append(sourceStatus, button("Manage Sources…", trigger => manage(trigger), "sr-link"));
        sourceNotice.hidden = true;
        const body = node("div", "", "sr-store-body");
        const platforms = [["ios", "iPhone & iPad"], ["tvos", "Apple TV"]].map(([id, label], index) => {
            const tab = button(label, () => selectPlatform(index), "btn");
            const panel = node("div", "", "sr-store-browse");
            const featuredSection = node("section", "", "sr-store-featured-section");
            featuredSection.hidden = true;
            panel.append(featuredSection);
            tab.id = `sr-store-tab-${id}`;
            panel.id = `sr-store-panel-${id}`;
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-controls", panel.id);
            panel.setAttribute("role", "tabpanel");
            panel.setAttribute("aria-labelledby", tab.id);
            tabs.append(tab);
            return { id, tab, panel, label, featuredSection };
        });
        header.append(leading, tools, tabs);
        const product = node("div", "", "sr-store-product");
        product.hidden = true;
        view.append(header, ...platforms.map(({ panel }) => panel), product);
        let activePlatform = 0;
        let returnToListing;
        let pendingHistory = history.state?.sideRelayStore;
        let categoryScroll = 0;
        let sources = [];
        let failed = [];
        let refreshing = false;
        let category = null;
        let downloading = false;
        let listings = [];
        let catalogueRevision;
        let listingObserver;
        let visibleCount = 0;
        const featuredShelves = new Map();
        const artwork = new Map();
        const imageRequests = new WeakMap();
        const pending = new Set();
        let activeImages = 0;

        function imageFor({ sourceId, address, size }) {
            const key = JSON.stringify([sourceId, address, size]);
            let request = artwork.get(key);
            if (request) artwork.delete(key);
            else request = catalogue("store-image", { sourceId, address, size }).then(({ image, mime }) => {
                if (image && mime) return "data:" + mime + ";base64," + image;
                artwork.delete(key);
            }, () => { artwork.delete(key); });
            artwork.set(key, request);
            if (artwork.size > 60) artwork.delete(artwork.keys().next().value);
            return request;
        }

        function drainImages() {
            for (const frame of pending) {
                if (activeImages >= 4) break;
                pending.delete(frame);
                if (!frame.isConnected || frame.closest("[hidden]")) continue;
                observer.unobserve(frame);
                const request = imageRequests.get(frame);
                activeImages += 1;
                void imageFor(request).then(async src => {
                    const { image } = request;
                    if (!src || !frame.isConnected) return;
                    image.src = src;
                    try { await image.decode(); } catch { return; }
                    if (!frame.isConnected) return;
                    image.hidden = false;
                    image.previousElementSibling?.setAttribute("hidden", "");
                    if (frame.classList.contains("sr-store-preview")) {
                        frame.toggleAttribute("data-landscape", image.naturalWidth > image.naturalHeight);
                        frame.disabled = false;
                        reportGalleryBounds();
                    }
                }).finally(() => {
                    activeImages -= 1;
                    drainImages();
                });
            }
        }
        const observer = new IntersectionObserver(entries => {
            for (const { target, isIntersecting } of entries) {
                if (isIntersecting) pending.add(target);
                else pending.delete(target);
            }
            drainImages();
        });

        function stopObserving(frame) {
            observer.unobserve(frame);
            pending.delete(frame);
        }

        function picture(edition, address, frame, size, fallback = "") {
            const placeholder = node("span", fallback);
            placeholder.setAttribute("aria-hidden", "true");
            frame.append(placeholder);
            if (address) {
                const image = node("img");
                image.alt = "";
                image.decoding = "async";
                image.hidden = true;
                frame.append(image);
                frame.dataset.address = address;
                imageRequests.set(frame, { image, sourceId: edition.source.id, address, size });
                observer.observe(frame);
            }
            return frame;
        }
        function icon(edition) {
            const frame = node("span", "", "sr-store-icon");
            if (edition.release.platform) frame.dataset.platform = edition.release.platform;
            return picture(edition, edition.app.icon, frame, "icon", edition.app.name.slice(0, 1).toUpperCase());
        }
        function subtitle({ app, source }) {
            return app.subtitle || app.developer || source.name;
        }
        function get(edition, progress = banner) {
            const mac = globalThis.sideRelayWebBridge?.appleTV === false && edition.release.platform === "tvOS";
            const control = button(edition.release.restricted ? "Publisher only" : mac ? "Download" : "Get", async trigger => {
                if (downloading) return;
                downloading = true;
                trigger.disabled = true;
                try {
                    const { source, app, release } = edition;
                    let targets;
                    if (!mac) {
                        progress.textContent = "Checking installation…";
                        targets = await prepare(edition, trigger);
                        if (!targets || !view.isConnected || !trigger.isConnected) return;
                    }
                    progress.textContent = "Downloading " + app.name + "…";
                    const ipa = await catalogue("download", { sourceId: source.id, bundleId: app.bundleId, versionId: release.id });
                    if (view.isConnected && trigger.isConnected) {
                        if (mac) {
                            globalThis.sideRelayWebBridge.downloadIPA(ipa.id);
                            progress.textContent = "Connect Docker to a Mac with Apple TV support to install directly from the Store.";
                            return;
                        }
                        await review(ipa, trigger, targets);
                    }
                    progress.textContent = "";
                } catch (error) {
                    const fallback = progress.textContent === "Checking installation…"
                        ? "Could not check installation. Try Get again." : "Could not download the IPA.";
                    progress.textContent = failure(error, fallback);
                } finally {
                    if (progress.textContent === "Checking installation…") progress.textContent = "";
                    downloading = false;
                    trigger.disabled = Boolean(edition.release.restricted);
                }
            }, "btn sr-store-get");
            control.disabled = Boolean(edition.release.restricted);
            if (mac) control.title = "Install with SideRelay for Mac";
            control.setAttribute("aria-label", control.textContent + " " + edition.app.name + ", version " + edition.release.version);
            return control;
        }

        function updateHeader() {
            const showingProduct = Boolean(returnToListing);
            const home = activePlatform === 1 ? "Apple TV" : "Discover";
            const destination = showingProduct ? category || (search.value.trim() ? "Search Results" : home) : home;
            back.hidden = !showingProduct && !category;
            back.setAttribute("aria-label", "Back to " + destination);
            back.title = "Back to " + destination;
            tabs.hidden = showingProduct;
            tools.hidden = showingProduct;
            heading.hidden = showingProduct;
            platforms.forEach(({ tab, panel }, index) => {
                const selected = index === activePlatform;
                tab.setAttribute("aria-selected", String(selected));
                tab.tabIndex = selected ? 0 : -1;
                panel.hidden = !selected || showingProduct;
            });
            reportGalleryBounds();
        }

        function selectPlatform(index) {
            if (index === activePlatform) return;
            recordView("replaceState");
            activePlatform = index;
            category = null;
            mountPlatform();
            render();
            window.scrollTo(0, 0);
            recordView("pushState");
        }

        function mountPlatform() {
            const { panel, label, featuredSection } = platforms[activePlatform];
            panel.prepend(sourceNotice, banner);
            featuredSection.after(body);
            search.placeholder = activePlatform === 1 ? "Search Apple TV apps" : "Search apps";
            search.setAttribute("aria-label", `Search ${label} apps`);
            updateHeader();
        }

        function showCategory(label) {
            recordView("replaceState");
            categoryScroll = window.scrollY;
            category = label;
            render();
            body.querySelector("h2")?.focus({ preventScroll: true });
            window.scrollTo(0, 0);
            recordView("pushState");
        }

        function recordView(method) {
            if (!onStorePage()) return;
            let position = history.state?.sideRelayStore?.position ?? 0;
            if (method === "pushState") farthestStoreEntry = ++position;
            history[method]({ ...history.state, sideRelayStore: {
                platform: activePlatform, category, query: search.value,
                listing: returnToListing?.id, offset: window.scrollY, visibleCount, position,
            } }, "");
        }

        function listingTrigger(id) {
            return [...platforms[activePlatform].panel.querySelectorAll("[data-store-listing]")].find(
                control => control.dataset.storeListing === id && !control.closest("[hidden]"));
        }

        function restoreView(state, restoreFocus = true) {
            const previous = clearProduct();
            const previousCategory = category;
            activePlatform = state?.platform === 1 ? 1 : 0;
            category = state?.category ?? null;
            search.value = state?.query ?? "";
            mountPlatform();
            render(state?.visibleCount);
            const listing = listings.find(item => item.id === state?.listing);
            if (listing) {
                detail(listing, listingTrigger(listing.id) ?? search, false);
            } else if (restoreFocus) {
                let target = body.querySelector("h2");
                if (previous) {
                    target = previous.trigger.isConnected ? previous.trigger : listingTrigger(previous.id);
                } else if (!category) {
                    target = [...body.querySelectorAll("[data-store-category]")].find(
                        control => control.dataset.storeCategory === previousCategory);
                }
                (target ?? search).focus({ preventScroll: true });
            }
            window.scrollTo(0, state?.offset ?? 0);
        }

        function goBack() {
            if (history.state?.sideRelayStore && (returnToListing || category)) {
                recordView("replaceState");
                history.back();
                return;
            }
            if (returnToListing) {
                closeProduct();
                return;
            }
            if (!category) return;
            const previousCategory = category;
            category = null;
            render();
            const trigger = [...body.querySelectorAll("[data-store-category]")].find(
                control => control.dataset.storeCategory === previousCategory);
            (trigger ?? search).focus({ preventScroll: true });
            window.scrollTo(0, categoryScroll);
        }

        function clearProduct() {
            const previous = returnToListing;
            if (!previous) return;
            returnToListing = undefined;
            product.hidden = true;
            for (const frame of product.querySelectorAll("[data-address]")) stopObserving(frame);
            product.replaceChildren();
            return previous;
        }

        function closeProduct() {
            const { trigger, offset } = clearProduct();
            updateHeader();
            (trigger.isConnected ? trigger : search).focus({ preventScroll: true });
            window.scrollTo(0, offset);
        }

        function showScreenshot(trigger, label) {
            const thumbnail = trigger.querySelector("img");
            if (!thumbnail || thumbnail.hidden) return;
            const dialog = node("dialog", "", "sr-store-screenshot");
            dialog.setAttribute("aria-label", label);
            const close = button("Close", () => dialog.close());
            close.autofocus = true;
            const fullSize = node("img");
            fullSize.src = thumbnail.src;
            fullSize.alt = label;
            dialog.append(close, fullSize);
            dialog.addEventListener("click", event => {
                if (event.target === dialog) dialog.close();
            });
            dialog.addEventListener("close", () => {
                dialog.remove();
                if (trigger.isConnected) trigger.focus({ preventScroll: true });
            }, { once: true });
            product.append(dialog);
            dialog.showModal();
            void imageFor({ ...imageRequests.get(trigger), size: "original" }).then(async src => {
                if (!src || !dialog.open || src === fullSize.src) return;
                const original = node("img");
                original.alt = label;
                original.src = src;
                try { await original.decode(); } catch { return; }
                if (dialog.open) fullSize.replaceWith(original);
            });
        }

        function detail(listing, trigger, remember = true) {
            if (remember) recordView("replaceState");
            const edition = listing.primary;
            const { app, release } = edition;
            returnToListing = { id: listing.id, trigger, offset: window.scrollY };
            const title = node("h1", app.name, "sr-store-product-title");
            title.tabIndex = -1;
            const identity = node("div", "", "sr-store-detail-identity");
            const message = feedback();
            const install = get(edition, message);
            install.classList.add("sr-store-product-get");
            identity.append(title, node("p", app.developer || subtitle(edition), "muted"), install);
            const head = node("header", "", "sr-store-detail-head");
            head.append(icon(edition), identity);

            const facts = node("dl", "", "sr-store-facts");
            const version = "Version " + release.version;
            const platform = release.platform || "iOS";
            for (const [label, value, secondary] of [
                ["Category", listing.category],
                ["Platform", platform, release.minOS && `Requires ${platform} ${release.minOS}+`],
                ["Version", release.version, release.build && `Build ${release.build}`],
            ]) {
                const fact = node("div");
                const definition = node("dd", value);
                if (secondary) definition.append(node("span", secondary));
                fact.append(node("dt", label), definition);
                facts.append(fact);
            }
            const page = node("article", "", "sr-store-product-page");
            page.append(head, message, facts);
            const artwork = appArtwork(listing, "screenshots");
            if (artwork) {
                const previews = node("div", "", "sr-store-preview-strip");
                previews.dataset.platform = platform;
                previews.tabIndex = 0;
                previews.setAttribute("aria-label", "Screenshots");
                for (const [index, url] of [...new Set(artwork.app.screenshots)].slice(0, 10).entries()) {
                    const label = `${app.name} screenshot ${index + 1}`;
                    const thumbnail = button("", trigger => showScreenshot(trigger, label), "sr-store-preview");
                    thumbnail.setAttribute("aria-label", `Enlarge ${label}`);
                    thumbnail.setAttribute("aria-haspopup", "dialog");
                    thumbnail.disabled = true;
                    previews.append(picture(artwork, url, thumbnail, "preview", "Preview unavailable"));
                }
                page.append(productSection("Preview", previews));
            }
            if (app.description) page.append(productSection("About", node("p", app.description, "sr-store-description")));

            const releaseDate = formatDate(release.date);
            if (release.notes || releaseDate) {
                const metadata = node("div", "", "sr-store-release-date");
                metadata.append(node("span", version), node("span", releaseDate || ""));
                const changes = productSection("What’s New", metadata);
                if (release.notes) changes.append(node("p", release.notes, "sr-store-description"));
                page.append(changes);
            }
            if (listing.releases.length > 1) {
                const versions = node("details", "", "sr-store-product-section");
                versions.append(node("summary", "Version History"));
                versions.addEventListener("toggle", () => {
                    if (!versions.open || versions.childElementCount > 1) return;
                    const rows = document.createDocumentFragment();
                    for (const variant of listing.releases.slice(1)) {
                        const row = node("div", "", "sr-store-version");
                        const label = [variant.app.name, variant.release.version, variant.source.name, formatDate(variant.release.date)];
                        row.append(node("span", label.filter(Boolean).join(" · ")), get(variant, message));
                        rows.append(row);
                    }
                    versions.append(rows);
                });
                page.append(versions);
            }
            const info = node("dl", "", "sr-store-information");
            const fields = [["Source", edition.source.name],
                ["Supported through", release.maxOS && `${platform} ${release.maxOS}`], ["Release", edition.preview && "Pre-release"]];
            for (const [label, value] of fields) {
                if (!value) continue;
                const pair = node("div");
                pair.append(node("dt", label), node("dd", value));
                info.append(pair);
            }
            page.append(productSection("Information", info));
            product.replaceChildren(page);
            product.hidden = false;
            updateHeader();
            title.focus({ preventScroll: true });
            window.scrollTo(0, 0);
            if (remember) recordView("pushState");
        }

        function productSection(title, ...content) {
            const section = node("section", "", "sr-store-product-section");
            section.append(node("h2", title), ...content);
            return section;
        }

        function row(listing, showDate) {
            const edition = listing.primary;
            const article = node("article", "", "sr-store-row");
            const open = button("", trigger => detail(listing, trigger), "sr-store-app");
            open.dataset.storeListing = listing.id;
            const copy = node("span");
            copy.append(node("strong", edition.app.name), node("span",
                (showDate && formatDate(edition.release.date)) || subtitle(edition), "muted"));
            open.append(icon(edition), copy);
            article.append(open, get(edition));
            return article;
        }
        function appArtwork(listing, field) {
            return listing.releases.find(edition =>
                edition.bundle === listing.primary.bundle && edition.app[field]?.length);
        }

        function feature(entry, artwork) {
            const { listing } = entry;
            const edition = listing.primary;
            const card = button("", trigger => detail(entry.listing, trigger), "sr-store-feature");
            card.dataset.storeListing = listing.id;
            const art = picture(artwork ?? edition, artwork?.app.preview, node("span", "", "sr-store-feature-art"), "preview");
            art.setAttribute("aria-hidden", "true");
            art.firstElementChild.append(icon(edition));
            card.style.setProperty("--store-feature-tint",
                categories.find(([name]) => name === listing.category)?.[1] ?? "var(--focus)");
            const copy = node("span", "", "sr-store-feature-copy");
            copy.append(node("strong", edition.app.name), node("span", subtitle(edition)));
            card.append(copy, art);
            return card;
        }
        function createFeaturedShelf(section) {
            const shelf = node("div", "", "sr-store-featured");
            shelf.tabIndex = 0;
            shelf.setAttribute("aria-label", "Featured apps");
            const head = node("div", "", "sr-store-section-head");
            const arrows = node("div", "", "sr-actions sr-store-shelf-controls");
            const previous = button("", () => move(-1), "btn sr-store-back");
            const next = button("", () => move(1), "btn sr-store-back sr-store-forward");
            previous.disabled = true;
            next.disabled = true;
            previous.setAttribute("aria-label", "Previous featured apps");
            next.setAttribute("aria-label", "Next featured apps");
            arrows.append(previous, next);
            head.append(node("h2", "Featured"), arrows);
            section.append(head, shelf);

            let entries = new Map();
            let limit = 0;
            let destination;
            let arrowFrame = 0;
            function updateArrows() {
                arrowFrame = 0;
                const left = shelf.scrollLeft;
                if (destination !== undefined && Math.abs(left - destination) <= 1) destination = undefined;
                const position = destination ?? left;
                const atStart = position <= 1;
                const atEnd = position >= limit - 1;
                if (previous.disabled !== atStart) previous.disabled = atStart;
                if (next.disabled !== atEnd) next.disabled = atEnd;
            }
            function scheduleArrows() {
                if (!arrowFrame) arrowFrame = requestAnimationFrame(updateArrows);
            }
            function measure() {
                const width = shelf.clientWidth;
                if (!width) return;
                limit = Math.max(0, shelf.scrollWidth - width);
                if (destination > limit) destination = undefined;
                scheduleArrows();
                reportGalleryBounds();
            }
            function move(direction) {
                measure();
                const first = shelf.firstElementChild;
                if (!first) return;
                const origin = first.offsetLeft;
                const positions = [...shelf.children].map(card => Math.min(limit, card.offsetLeft - origin));
                const position = destination ?? shelf.scrollLeft;
                destination = direction > 0 ? positions.find(left => left > position + 1) ?? limit
                    : positions.findLast(left => left < position - 1) ?? 0;
                shelf.scrollTo({ left: destination,
                    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
                scheduleArrows();
            }
            shelf.addEventListener("scroll", scheduleArrows, { passive: true });
            for (const event of ["wheel", "pointerdown", "keydown"]) {
                shelf.addEventListener(event, () => {
                    if (destination === undefined) return;
                    destination = undefined;
                    scheduleArrows();
                }, { passive: true });
            }
            const resize = new ResizeObserver(measure);
            resize.observe(shelf);

            return selected => {
                const previousEntries = entries;
                entries = new Map();
                for (const listing of selected) {
                    const { app, source } = listing.primary;
                    const artwork = appArtwork(listing, "preview");
                    const appearance = JSON.stringify([
                        app.name, subtitle(listing.primary), listing.category, source.id, app.icon,
                        artwork?.source.id, artwork?.app.preview,
                    ]);
                    let entry = previousEntries.get(listing.id);
                    if (entry?.appearance !== appearance) {
                        if (entry) {
                            for (const frame of entry.card.querySelectorAll("[data-address]")) stopObserving(frame);
                            entry.card.remove();
                        }
                        entry = { listing, appearance };
                        entry.card = feature(entry, artwork);
                    }
                    entry.listing = listing;
                    entries.set(listing.id, entry);
                    previousEntries.delete(listing.id);
                }
                let changed = previousEntries.size > 0;
                for (const { card } of previousEntries.values()) {
                    for (const frame of card.querySelectorAll("[data-address]")) stopObserving(frame);
                    card.remove();
                }
                let index = 0;
                for (const { card } of entries.values()) {
                    const current = shelf.children[index++] ?? null;
                    if (card !== current) {
                        shelf.insertBefore(card, current);
                        changed = true;
                    }
                }
                // Keep the scroll node and unchanged cards attached during catalogue refreshes.
                if (changed) measure();
            };
        }
        function renderFeatured(platform, platformListings, browsing) {
            const { id, featuredSection } = platform;
            const selection = browsing ? featured[id]
                .map(bundle => platformListings.find(listing => listing.id === bundle)).filter(Boolean) : [];
            featuredSection.hidden = !selection.length;
            if (!selection.length) return;
            if (!featuredShelves.has(id)) featuredShelves.set(id, createFeaturedShelf(featuredSection));
            featuredShelves.get(id)(selection);
        }
        function appRows(items, showDate = false) {
            const grid = node("div", "", "sr-store-rows");
            for (const listing of items) grid.append(row(listing, showDate));
            return grid;
        }
        function appendListing(items, showDate, restoreCount) {
            const batchSize = 48;
            const grid = appRows(items.slice(0, Math.max(batchSize, restoreCount || 0)), showDate);
            body.append(grid);
            visibleCount = grid.childElementCount;
            if (visibleCount >= items.length) return;
            const sentinel = node("div", "", "sr-store-list-end");
            sentinel.setAttribute("aria-hidden", "true");
            body.append(sentinel);
            listingObserver = new IntersectionObserver(([entry], observer) => {
                if (!entry.isIntersecting || !sentinel.isConnected) return;
                const rows = document.createDocumentFragment();
                for (const listing of items.slice(visibleCount, visibleCount + batchSize)) rows.append(row(listing, showDate));
                grid.append(rows);
                visibleCount = grid.childElementCount;
                if (visibleCount >= items.length) {
                    observer.disconnect();
                    sentinel.remove();
                }
            }, { rootMargin: "600px 0px" });
            listingObserver.observe(sentinel);
        }
        function catalogueLink(label, section, style = "sr-link") {
            const control = button(label, () => showCategory(section), style);
            control.dataset.storeCategory = section;
            return control;
        }
        function render(restoreCount = 0) {
            if (!view.isConnected) return;
            updateHeader();
            listingObserver?.disconnect();
            visibleCount = 0;
            const query = search.value.trim().toLocaleLowerCase();
            const isTV = activePlatform === 1;
            const platformListings = listings.filter(({ primary }) => (primary.release.platform === "tvOS") === isTV);
            renderFeatured(platforms[activePlatform], platformListings, !query && !category);
            for (const frame of body.querySelectorAll("[data-address]")) stopObserving(frame);
            body.replaceChildren();
            const matches = platformListings.filter(listing => {
                if (category === releases2026 && !listing.releases.some(({ release }) => is2026(release))) return false;
                if (category && !["All Apps", "Recently Updated", releases2026].includes(category) && listing.category !== category) return false;
                return !query || listing.searchTerms.includes(query);
            });
            if (query || category) {
                const title = node("h2", category || "Search Results");
                title.tabIndex = -1;
                const showDates = category === "Recently Updated" || category === releases2026;
                const ordered = category === "Recently Updated" ? recent(matches) : matches;
                body.append(title);
                if (ordered.length) appendListing(ordered, showDates, restoreCount);
                else body.append(node("p", "No matching apps.", "muted"));
                return;
            }
            if (!platformListings.length) {
                body.append(node("p", refreshing ? "Loading apps…" : failed.length ? "The catalogues couldn’t load." : "No apps available.", "muted"));
                if (!refreshing) body.append(button("Reload Sources", () => refresh(true)));
                return;
            }
            const updated = recent(platformListings);
            if (updated.length) {
                const shelf = node("section", "", "sr-store-section");
                const head = node("div", "", "sr-store-section-head");
                head.append(node("h2", "Recently Updated"));
                if (updated.length > 6) {
                    const seeAll = catalogueLink("See All", "Recently Updated");
                    seeAll.setAttribute("aria-label", "See all recently updated apps");
                    head.append(seeAll);
                }
                shelf.append(head, appRows(updated.slice(0, 6)));
                body.append(shelf);
            }
            const browse = node("section", "", "sr-store-section");
            const head = node("div", "", "sr-store-section-head");
            head.append(node("h2", "Categories"), catalogueLink("All Apps", "All Apps"));
            const tiles = node("div", "", "sr-store-categories");
            for (const [label] of categories) {
                if (platformListings.some(item => item.category === label)) {
                    tiles.append(catalogueLink(label, label, "sr-store-category"));
                }
            }
            if (platformListings.some(item => item.releases.some(({ release }) => is2026(release)))) {
                tiles.append(catalogueLink(releases2026, releases2026, "sr-store-category"));
            }
            browse.append(head, tiles);
            body.append(browse);
        }
        function recent(items) {
            return items.filter(({ primary }) => !primary.preview && !primary.release.restricted && date(primary.release.date))
                .sort((a, b) => date(b.primary.release.date) - date(a.primary.release.date));
        }
        function update({ sources: next, githubRetryAt }) {
            sources = next;
            failed = sources.filter(source => source.refreshError);
            sourceStatus.textContent = githubRetryMessage(githubRetryAt) || (failed.length === 1
                ? `${failed[0].name} couldn’t refresh.`
                : failed.length ? `${failed.length} sources couldn’t refresh.` : "");
            sourceNotice.hidden = !sourceStatus.textContent;
            const revision = next.every(source => source.revision) ? JSON.stringify(next.map(
                source => [source.id, source.name, source.curated, source.revision])) : undefined;
            if (revision !== undefined && catalogueRevision === revision && !pendingHistory) return;
            catalogueRevision = revision;
            listings = listingsFrom(sources);
            if (pendingHistory) {
                const previous = pendingHistory;
                pendingHistory = undefined;
                restoreView(previous, false);
            } else {
                render(visibleCount);
            }
        }
        async function refresh(force = false) {
            if (refreshing) return;
            refreshing = true;
            const platformIsEmpty = () => !listings.some(({ primary }) => (primary.release.platform === "tvOS") === (activePlatform === 1));
            if (view.isConnected) banner.textContent = force ? "Refreshing sources…" : "";
            if (platformIsEmpty()) render();
            try {
                if (!sources.length) {
                    const cached = await catalogue("store");
                    update(cached);
                    if (!force && cached.refreshAfter * 1000 > Date.now()) return;
                }
                const result = await catalogue("refresh-store", force ? { force: "yes" } : {});
                update(result);
                if (view.isConnected) banner.textContent = "";
            } catch (error) {
                if (view.isConnected) banner.textContent = failure(error, "Could not load the Store.");
            } finally {
                refreshing = false;
                if (platformIsEmpty()) render();
            }
        }
        mountPlatform();
        if (!nativePortal && onStorePage()) history.scrollRestoration = "manual";
        view.addEventListener("sr-store-history", event => {
            if (sources.length) restoreView(event.detail);
            else pendingHistory = event.detail ?? {};
        });
        view.addEventListener("sr-store-save-history", () => {
            const state = history.state?.sideRelayStore;
            if (state && (state.offset !== window.scrollY || state.visibleCount !== visibleCount)) {
                recordView("replaceState");
            }
        });
        search.addEventListener("input", () => render());
        tabs.addEventListener("keydown", event => {
            const last = platforms.length - 1;
            const next = { ArrowLeft: (activePlatform + last) % platforms.length,
                ArrowRight: (activePlatform + 1) % platforms.length, Home: 0, End: last }[event.key];
            if (next === undefined) return;
            event.preventDefault();
            selectPlatform(next);
            platforms[next].tab.focus();
        });
        view.addEventListener("keydown", event => {
            if (event.key === "Escape" && returnToListing && !document.querySelector("dialog[open]")) {
                event.preventDefault();
                goBack();
            }
        });
        return { view, refresh, update };
    };
})();
