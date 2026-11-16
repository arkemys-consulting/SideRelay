(() => {
    if (location.origin !== "http://127.0.0.1:18784" && !globalThis.sideRelayWebBridge) return;

    const categories = [
        ["Games", "◉", "#6558e6"], ["Emulators", "▦", "#ad60ee"],
        ["Entertainment", "▶", "#3184df"], ["Music", "♪", "#e74774"],
        ["Productivity", "✓", "#238e83"], ["Utilities", "⚙", "#ca6e22"],
        ["Developer Tools", "›_", "#397acb"], ["Books & Reading", "▤", "#a9734e"],
        ["Health & Fitness", "♥", "#d9515d"], ["Lifestyle", "✧", "#278c77"],
        ["Social", "◌", "#3389a8"], ["Other", "⋯", "#747784"],
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
    const date = value => Date.parse(value || "") || 0;
    const releases2026 = "2026 Releases";
    const is2026 = release => /^2026-\d{2}-\d{2}/.test(release.date || "") && date(release.date) <= Date.now();
    const featured = {
        ios: ["com.rileytestut.delta", "app.aidoku.aidoku", "app.lokal.mobile",
            "stream.yattee.app", "app.folio.paperless", "com.utmapp.utm"],
        tvos: ["com.example.orbrisa/tvos", "com.gstudios.rivulet/tvos", "com.xlnd47.afterburner/tvos",
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
                || b.release.version.localeCompare(a.release.version, undefined, { numeric: true })
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
            return { id, primary, category, releases };
        }).sort((a, b) => a.primary.app.name.localeCompare(b.primary.app.name));
    }

    globalThis.sideRelayStore = function ({ node, button, feedback, catalogue, formatDate, prepare, review, manage, failure }) {
        const view = node("section", "", "sr-store");
        view.setAttribute("aria-label", "Store");
        const header = node("header", "", "sr-store-header");
        const heading = node("h1", "Store");
        const leading = node("div", "", "sr-store-leading");
        const back = button("", goBack, "btn sr-store-back");
        back.hidden = true;
        leading.append(back, heading);
        const tools = node("div", "", "sr-store-toolbar");
        const search = node("input");
        search.type = "search";
        const searchField = node("label", "", "sr-store-search");
        searchField.append(search);
        const more = button("More", async trigger => {
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
        }, "btn btn-secondary sr-toolbar-menu");
        more.setAttribute("aria-label", "More Store actions");
        more.setAttribute("aria-haspopup", "menu");
        tools.append(searchField, more);
        const tabs = node("div", "", "sr-catalogue-tabs sr-store-tabs");
        tabs.setAttribute("role", "tablist");
        tabs.setAttribute("aria-label", "Store platform");
        const banner = feedback();
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
        let categoryScroll = 0;
        let sources = [];
        let failed = [];
        let refreshing = false;
        let category = null;
        let downloading = false;
        let listings = [];
        const featuredShelves = new Map();
        const artwork = new Map();
        const pending = [];
        let activeImages = 0;

        function drainImages() {
            while (activeImages < 5 && pending.length) {
                const { image, source, address } = pending.shift();
                if (!image.isConnected || !view.isConnected) continue;
                const key = source.id + address;
                if (!artwork.has(key)) {
                    if (artwork.size >= 80) artwork.delete(artwork.keys().next().value);
                    artwork.set(key, catalogue("store-image", { sourceId: source.id, address }).catch(() => {
                        artwork.delete(key);
                        return {};
                    }));
                }
                activeImages += 1;
                void artwork.get(key).then(({ image: data, mime }) => {
                    if (data && image.isConnected) {
                        image.addEventListener("load", () => {
                            const frame = image.parentElement;
                            if (frame?.classList.contains("sr-store-preview") && image.naturalHeight > 0) {
                                frame.style.setProperty("--preview-width", Math.round(245 * image.naturalWidth / image.naturalHeight) + "px");
                            }
                            image.hidden = false;
                            image.previousElementSibling?.setAttribute("hidden", "");
                        }, { once: true });
                        image.src = "data:" + mime + ";base64," + data;
                    }
                }).finally(() => {
                    activeImages -= 1;
                    drainImages();
                });
            }
        }
        const observer = new IntersectionObserver(entries => {
            for (const { target, isIntersecting } of entries) {
                if (!isIntersecting) continue;
                observer.unobserve(target);
                const source = sources.find(item => item.id === target.dataset.source);
                const image = target.querySelector(":scope > img");
                if (source && image) pending.push({ image, source, address: target.dataset.address });
            }
            drainImages();
        });

        function picture(edition, address, style, fallback = "", eager = false) {
            const frame = node("span", "", style);
            const placeholder = node("span", fallback);
            placeholder.setAttribute("aria-hidden", "true");
            frame.append(placeholder);
            if (address) {
                const image = node("img");
                image.alt = "";
                image.decoding = "async";
                image.hidden = true;
                frame.append(image);
                if (eager) {
                    pending.push({ image, source: edition.source, address });
                } else {
                    frame.dataset.source = edition.source.id;
                    frame.dataset.address = address;
                    observer.observe(frame);
                }
            }
            return frame;
        }
        function icon(edition, eager = false) {
            return picture(edition, edition.app.icon, "sr-store-icon", edition.app.name.slice(0, 1).toUpperCase(), eager);
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
            const home = activePlatform === 1 ? "Apple TV" : "Store";
            const destination = showingProduct ? category || (search.value.trim() ? "Search Results" : home) : home;
            back.hidden = !showingProduct && !category;
            back.setAttribute("aria-label", "Back to " + destination);
            back.title = "Back to " + destination;
            tabs.hidden = showingProduct;
            tools.hidden = showingProduct;
            platforms.forEach(({ tab, panel }, index) => {
                const selected = index === activePlatform;
                tab.setAttribute("aria-selected", String(selected));
                tab.tabIndex = selected ? 0 : -1;
                panel.hidden = !selected || showingProduct;
            });
        }

        function selectPlatform(index) {
            if (index === activePlatform) return;
            activePlatform = index;
            category = null;
            mountPlatform();
            render();
            window.scrollTo(0, 0);
        }

        function mountPlatform() {
            const { panel, label, featuredSection } = platforms[activePlatform];
            panel.prepend(banner);
            featuredSection.after(body);
            search.placeholder = activePlatform === 1 ? "Search Apple TV apps" : "Search apps";
            search.setAttribute("aria-label", `Search ${label} apps`);
            updateHeader();
        }

        function showCategory(label) {
            categoryScroll = window.scrollY;
            category = label;
            render();
            body.querySelector("h2")?.focus({ preventScroll: true });
            window.scrollTo(0, 0);
        }

        function goBack() {
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

        function closeProduct() {
            const { trigger, offset } = returnToListing;
            returnToListing = undefined;
            product.hidden = true;
            for (const frame of product.querySelectorAll("[data-address]")) observer.unobserve(frame);
            product.replaceChildren();
            updateHeader();
            (trigger.isConnected ? trigger : search).focus({ preventScroll: true });
            window.scrollTo(0, offset);
        }

        function detail(listing, trigger) {
            const edition = listing.primary;
            const { app, release } = edition;
            returnToListing = { trigger, offset: window.scrollY };
            const title = node("h2", app.name, "sr-store-product-title");
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
            const compatibility = release.minOS ? platform + " " + release.minOS + "+" : release.platform;
            for (const [label, value] of [["Category", listing.category], ["Version", release.version], ["Compatibility", compatibility]]) {
                if (!value) continue;
                const pair = node("div");
                pair.append(node("dt", label), node("dd", value));
                facts.append(pair);
            }
            const page = node("article", "", "sr-store-product-page");
            page.append(head, message, facts);
            const artwork = [edition, ...listing.releases].find(candidate =>
                candidate.bundle === edition.bundle && candidate.app.screenshots?.length);
            if (artwork) {
                const previews = node("div", "", "sr-store-preview-strip");
                previews.tabIndex = 0;
                previews.setAttribute("aria-label", "Screenshots");
                for (const url of [...new Set(artwork.app.screenshots)].slice(0, 10)) {
                    previews.append(picture(artwork, url, "sr-store-preview", "Preview unavailable"));
                }
                page.append(productSection("Preview", previews));
            }
            if (app.description) page.append(node("p", app.description, "sr-store-description"));

            const metadata = node("div", "", "sr-store-release-date");
            metadata.append(node("span", version), node("span", formatDate(release.date) || "Date unavailable"));
            const notes = node("p", release.notes || "Release notes unavailable.",
                release.notes ? "sr-store-description" : "muted");
            page.append(productSection("What’s New", metadata, notes));
            if (listing.releases.length > 1) {
                const versions = node("details", "", "sr-store-product-section");
                versions.append(node("summary", "Other Versions"));
                for (const variant of listing.releases.slice(1)) {
                    const row = node("div", "", "sr-store-version");
                    const label = [variant.app.name, variant.release.version, variant.source.name, formatDate(variant.release.date)];
                    row.append(node("span", label.filter(Boolean).join(" · ")), get(variant, message));
                    versions.append(row);
                }
                page.append(versions);
            }
            const info = node("dl", "", "sr-store-information");
            const fields = [["Developer", app.developer], ["Source", edition.source.name],
                ["Compatibility", release.minOS && `Requires ${platform} ${release.minOS} or later`],
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
            const copy = node("span");
            copy.append(node("strong", edition.app.name), node("span",
                (showDate && formatDate(edition.release.date)) || subtitle(edition), "muted"));
            open.append(icon(edition), copy);
            article.append(open, get(edition));
            return article;
        }
        function feature(entry) {
            const { listing } = entry;
            const edition = listing.primary;
            const card = button("", trigger => detail(entry.listing, trigger), "sr-store-feature");
            const preview = picture(edition, edition.app.preview, "sr-store-feature-art", "", true);
            preview.firstElementChild.append(icon(edition, true));
            const categoryColor = categories.find(([name]) => name === listing.category)?.[2] ?? "var(--focus)";
            preview.style.setProperty("--store-feature-tint", categoryColor);
            const copy = node("span", "", "sr-store-feature-copy");
            const labels = node("span");
            labels.append(node("strong", edition.app.name), node("span", subtitle(edition), "muted"));
            copy.append(labels);
            card.append(preview, copy);
            return card;
        }
        function createFeaturedShelf(section) {
            const shelf = node("div", "", "sr-store-featured");
            shelf.tabIndex = 0;
            shelf.setAttribute("aria-label", "Featured apps");
            const head = node("div", "", "sr-store-section-head");
            const arrows = node("div", "", "sr-actions sr-store-shelf-controls");
            const previous = button("‹", () => move(-1));
            const next = button("›", () => move(1));
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
            }
            function move(direction) {
                measure();
                const origin = shelf.firstElementChild.offsetLeft;
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
                    const appearance = JSON.stringify([
                        app.name, subtitle(listing.primary), listing.category, source.id, app.preview, app.icon,
                    ]);
                    let entry = previousEntries.get(listing.id);
                    if (entry?.appearance !== appearance) {
                        entry?.card.remove();
                        entry = { listing, appearance };
                        entry.card = feature(entry);
                    }
                    entry.listing = listing;
                    entries.set(listing.id, entry);
                    previousEntries.delete(listing.id);
                }
                let changed = previousEntries.size > 0;
                for (const { card } of previousEntries.values()) card.remove();
                let index = 0;
                for (const { card } of entries.values()) {
                    const current = shelf.children[index++] ?? null;
                    if (card !== current) {
                        shelf.insertBefore(card, current);
                        changed = true;
                    }
                }
                // Keep the scroll node and unchanged cards attached during catalogue refreshes.
                if (changed) {
                    drainImages();
                    measure();
                }
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
        function categoryButton(label, symbol, color) {
            const control = button(label, () => showCategory(label), "sr-store-category");
            control.dataset.storeCategory = label;
            const mark = node("span", symbol);
            mark.setAttribute("aria-hidden", "true");
            mark.style.color = color;
            control.prepend(mark);
            return control;
        }
        function render() {
            if (!view.isConnected) return;
            updateHeader();
            const query = search.value.trim().toLocaleLowerCase();
            const isTV = activePlatform === 1;
            const platformListings = listings.filter(({ primary }) => (primary.release.platform === "tvOS") === isTV);
            renderFeatured(platforms[activePlatform], platformListings, !query && !category);
            for (const frame of body.querySelectorAll("[data-address]")) observer.unobserve(frame);
            body.replaceChildren();
            const matches = platformListings.filter(listing => {
                if (category === releases2026 && !listing.releases.some(({ release }) => is2026(release))) return false;
                if (category && !["All Apps", "Recently Updated", releases2026].includes(category) && listing.category !== category) return false;
                return !query || [listing.category, ...listing.releases.flatMap(({ app, source }) =>
                    [app.name, app.developer, app.bundleId, app.subtitle, source.name])].some(value => value?.toLocaleLowerCase().includes(query));
            });
            if (query || category) {
                const title = node("h2", category || "Search Results");
                title.tabIndex = -1;
                const showDates = category === "Recently Updated" || category === releases2026;
                const ordered = category === "Recently Updated" ? recent(matches) : matches;
                body.append(title, ordered.length ? appRows(ordered, showDates) : node("p", "No matching apps.", "muted"));
                return;
            }
            if (!platformListings.length) {
                body.append(node("p", refreshing ? "Loading apps…" : failed.length ? "The catalogues couldn’t load." : "No apps available.", "muted"));
                if (!refreshing) body.append(button("Reload Sources", () => refresh(true)));
                return;
            }
            const tiles = node("div", "", "sr-store-categories");
            for (const [label, symbol, color] of categories) {
                if (platformListings.some(item => item.category === label)) tiles.append(categoryButton(label, symbol, color));
            }
            if (platformListings.some(item => item.releases.some(({ release }) => is2026(release)))) {
                tiles.append(categoryButton(releases2026, "↗", "var(--focus)"));
            }
            tiles.append(categoryButton("All Apps", "▦", "var(--muted)"));
            const updated = recent(platformListings);
            if (updated.length) {
                const head = node("div", "", "sr-store-section-head");
                head.append(node("h2", "Recently Updated"));
                if (updated.length > 6) {
                    const seeAll = button("See All", () => showCategory("Recently Updated"), "sr-link");
                    seeAll.dataset.storeCategory = "Recently Updated";
                    head.append(seeAll);
                }
                body.append(head, appRows(updated.slice(0, 6), true));
            }
            body.append(node("h2", "Browse Categories"), tiles);
        }
        function recent(items) {
            return items.filter(({ primary }) => !primary.preview && !primary.release.restricted && date(primary.release.date))
                .sort((a, b) => date(b.primary.release.date) - date(a.primary.release.date));
        }
        function update(next) {
            sources = next;
            listings = listingsFrom(sources);
            render();
        }
        async function refresh(force = false) {
            if (refreshing) return;
            refreshing = true;
            const platformIsEmpty = () => !listings.some(({ primary }) => (primary.release.platform === "tvOS") === (activePlatform === 1));
            if (view.isConnected) banner.textContent = force ? "Refreshing sources…" : "";
            if (platformIsEmpty()) render();
            try {
                if (!sources.length) update((await catalogue("store")).sources);
                const result = await catalogue("refresh-store", force ? { force: "yes" } : {});
                failed = result.failed || [];
                update(result.sources);
                if (view.isConnected) banner.textContent = failed.length ? "Some sources couldn’t load. Open More → Manage Sources." : "";
            } catch (error) {
                if (view.isConnected) banner.textContent = failure(error, "Could not load the Store.");
            } finally {
                refreshing = false;
                if (platformIsEmpty()) render();
            }
        }
        mountPlatform();
        search.addEventListener("input", render);
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
            if (event.key === "Escape" && returnToListing) {
                event.preventDefault();
                closeProduct();
            }
        });
        return { view, refresh, update };
    };
})();
