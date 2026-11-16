(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;
    const pont = window.webkit.messageHandlers.signatureCompte;
    const commandes = new WeakSet();
    const cheminApps = "/?view=apps";
    const cheminStore = "/?view=store";

    function element(tag, texte, classe) {
        const n = document.createElement(tag);
        if (texte) n.textContent = texte;
        if (classe) n.className = classe;
        return n;
    }

    function dateApp(valeur) {
        if (!valeur) return "—";
        const date = new Date(Number(valeur) * (Number(valeur) < 1e11 ? 1000 : 1));
        return isNaN(date.getTime()) ? "—" : new Intl.DateTimeFormat(document.documentElement.lang, {
            dateStyle: "medium",
        }).format(date);
    }

    function echeanceSignature(secondes) {
        const date = dateApp(secondes);
        if (date === "—") return ["Signature Expires", "Unknown"];
        const timestamp = Number(secondes);
        const fin = timestamp < 1e11 ? timestamp * 1000 : timestamp;
        const reste = fin - Date.now();
        const jour = 86_400_000;
        const niveau = reste <= jour ? "critical" : reste <= 3 * jour ? "soon" : "valid";
        const valeur = element("time", date, "sr-expiry-date " + niveau);
        valeur.dateTime = new Date(fin).toISOString();
        const jours = Math.ceil(reste / jour);
        const delai = reste <= 0 ? "Expired"
            : reste < jour ? "Less than a day left" : jours === 1 ? "1 day left" : `${jours} days left`;
        valeur.title = delai;
        valeur.setAttribute("aria-label", `${date}. ${delai}.`);
        const libelle = reste <= 0 ? "Signature Expired" : niveau === "valid" ? "Signature Expires" : "Signature Expires Soon";
        return [libelle, valeur];
    }

    function etatApp(app) {
        if (app.signingRepair) return ["Re-signing required", "job-failed"];
        if (app.installedAt) return ["Installed", "job-done"];
        switch (app.installStatus) {
            case "failed": return ["Installation failed", "job-failed"];
            case "running": return ["Installing…", "job-running"];
            case "queued": return ["Installation queued", "job-queued"];
            default: return ["Not installed", "job-queued"];
        }
    }

    function documentDialog(app, deleting = false) {
        return new Promise(resolve => {
            const dialog = element("dialog", "", "sr-certificate-review sr-package-dialog sr-documents-dialog");
            const title = element("h2", deleting ? `Delete ${app.name || "this app"}?` : `Documents · ${app.name || "App"}`);
            title.id = "sr-documents-dialog-title";
            dialog.setAttribute("aria-labelledby", title.id);
            const status = element("p", "Checking Apple File Sharing…");
            status.setAttribute("role", "status");
            const actions = element("div", "", "sr-actions");
            const cancel = bouton(deleting ? "Cancel" : "Close", () => dialog.close());
            cancel.autofocus = true;
            const label = element("label", "Restore from backup");
            const select = element("select");
            label.append(select);
            label.hidden = true;
            let busy = false;
            let choice = null;
            let shared = false;
            const { requete } = globalThis.sideRelayJobs;
            const call = (action, snapshot = "", timeout = 45000) =>
                requete("app_documents", { app_id: app.id, action, snapshot }, AbortSignal.timeout(timeout));
            async function list() {
                const data = await call("status");
                select.replaceChildren();
                for (const entry of data.snapshots) {
                    const date = new Date(entry.created * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
                    select.append(new Option(`${date} · ${entry.files} ${entry.files === 1 ? "file" : "files"}`, entry.id));
                }
                label.hidden = !select.options.length;
                restore.disabled = !shared || !select.options.length;
            }
            function errorMessage(error, fallback) {
                const raw = error?.message || "";
                if (raw.startsWith("ServerError|")) {
                    const detail = raw.slice("ServerError|".length);
                    if (detail.includes("InstallationLookupFailed")) {
                        return "Apple File Sharing could not open this app’s Documents. The app must have file sharing enabled.";
                    }
                    return detail;
                }
                try {
                    const json = JSON.parse(raw);
                    return json.ServerError || json.error || fallback;
                } catch { return fallback; }
            }
            const backup = bouton(deleting ? "Back Up and Delete" : "Back Up Documents", async () => {
                if (busy || !shared) return;
                busy = true;
                backup.disabled = restore.disabled = cancel.disabled = true;
                if (remove) remove.disabled = true;
                status.textContent = "Backing up shared documents…";
                try {
                    const data = await call("backup", "", 650000);
                    if (deleting) {
                        choice = "backedUp";
                        dialog.close();
                    } else {
                        status.textContent = `Backup saved on this Mac · ${data.snapshot.files} ${data.snapshot.files === 1 ? "file" : "files"}.`;
                        await list();
                    }
                } catch (error) {
                    status.textContent = errorMessage(error, "Could not back up the shared documents.") +
                        (deleting ? " The app was not deleted." : "");
                } finally {
                    busy = false;
                    backup.disabled = cancel.disabled = false;
                    restore.disabled = !shared || !select.options.length;
                    if (remove) remove.disabled = false;
                }
            });
            const restore = bouton("Restore Documents…", async () => {
                if (busy || !shared || !select.value ||
                    !window.confirm("Restore the selected backup? Existing files on the iPhone will be kept.")) return;
                busy = true;
                backup.disabled = restore.disabled = cancel.disabled = select.disabled = true;
                status.textContent = "Restoring shared documents…";
                try {
                    const result = await call("restore", select.value, 650000);
                    status.textContent = `${result.restored} restored · ${result.skipped} skipped because a file or folder already exists.`;
                } catch (error) {
                    status.textContent = errorMessage(error, "Could not restore the shared documents.");
                } finally {
                    busy = false;
                    backup.disabled = restore.disabled = cancel.disabled = select.disabled = false;
                }
            });
            const remove = deleting ? bouton("Delete Without Backing Up", () => {
                choice = "delete";
                dialog.close();
            }, "btn sr-app-delete") : null;
            backup.disabled = true;
            restore.disabled = true;
            if (deleting) dialog.append(title, element("p", "This uninstalls the app and deletes its local data. A documents backup includes only files the app shares."));
            else dialog.append(title, label);
            actions.append(cancel, backup, deleting ? remove : restore);
            dialog.append(status, actions);
            dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
            dialog.addEventListener("close", () => { dialog.remove(); resolve(choice); }, { once: true });
            document.body.append(dialog);
            dialog.showModal();
            void Promise.allSettled([deleting ? Promise.resolve() : list(), call("probe")]).then(([saved, access]) => {
                if (!dialog.open) return;
                shared = access.status === "fulfilled";
                backup.disabled = !shared;
                restore.disabled = !shared || !select.options.length;
                status.textContent = shared
                    ? (saved.status === "rejected" ? "Could not read saved backups." : "")
                    : errorMessage(access.reason, "Could not connect to Apple File Sharing.");
            });
        });
    }

    function commandesApp(app, gestion, item, entete, informations) {
        const { requete, suivreJob } = globalThis.sideRelayJobs;
        const installee = Boolean(app.installedAt);
        const pied = element("div", "", "sr-app-footer");
        const barre = element("div", "", "sr-app-controls");
        const statut = element("p", "", "sr-app-action-status");
        statut.setAttribute("role", "status");
        const controles = [];
        let renouveler;

        function afficherRetour() {
            const retour = gestion.retours.get(app.id);
            const texte = retour?.texte || (app.activeJob ? "Operation in progress." : "");
            statut.replaceChildren(texte);
            if (retour?.activite || (!retour && app.activeJob)) {
                statut.append(" ", lien("Open Activity", "/queue", "sr-app-activity-link"));
            }
            for (const controle of controles) controle.disabled = Boolean(app.activeJob) || gestion.enCours.has(app.id);
            gestion.actionsPrincipales.get(item)?.();
        }

        function informer(texte, activite = false) {
            gestion.retours.set(app.id, { texte, activite });
            afficherRetour();
        }

        async function agir(travail, echec) {
            if (app.activeJob || gestion.enCours.has(app.id)) return;
            gestion.enCours.add(app.id);
            afficherRetour();
            try { await travail(); }
            catch { informer(echec); }
            finally {
                gestion.enCours.delete(app.id);
                afficherRetour();
                gestion.reprendre();
            }
        }

        if (installee && app.canRefresh) {
            const auto = document.createElement("input");
            auto.type = "checkbox";
            auto.setAttribute("switch", "");
            auto.checked = Boolean(app.autoRefresh);
            const etiquette = element("label", "", "sr-app-auto-refresh");
            etiquette.append(auto, "Auto-Refresh");
            auto.addEventListener("change", evenement => {
                if (!evenement.isTrusted) return;
                const enabled = auto.checked;
                void agir(async () => {
                    informer("Saving…");
                    try {
                        await requete("set_refresh_enabled", { app_id: app.id, enabled: String(enabled) });
                        app.autoRefresh = enabled;
                        informer(enabled ? "Auto-Refresh enabled." : "Auto-Refresh disabled.");
                    } finally { auto.checked = Boolean(app.autoRefresh); }
                }, "Could not save Auto-Refresh. Try again.");
            });
            renouveler = () => agir(async () => {
                informer("Starting refresh…");
                try {
                    const job = await requete("refresh_app", { app_id: app.id });
                    if (typeof job !== "string" || !job) throw new Error("No refresh job");
                    informer("Refresh queued.", true);
                    const etat = await suivreJob(job, () => item.isConnected, courant => {
                        informer(courant.status === "running" ? "Refreshing…" : "Refresh queued.", true);
                    });
                    if (!item.isConnected) return;
                    if (etat?.status === "done") informer("Refreshed.");
                    else if (["cancelled", "canceled"].includes(etat?.status)) informer("Refresh was cancelled.", true);
                    else if (etat?.status === "failed") {
                        informer(globalThis.sideRelayJobs.messageErreur(etat.error, "Refresh failed."), true);
                    } else informer("Refresh is still in progress.", true);
                } catch { informer("Could not confirm the refresh.", true); }
                finally { gestion.relire(); }
            }, "Could not start the refresh.");
            informations.append(etiquette);
            controles.push(auto);
        } else if (installee) {
            informations.append(element("p", app.account ? "No IPA saved for refresh." : "No Apple Account linked for refresh.", "sr-app-refresh-note"));
        }

        const documents = () => agir(() => documentDialog(app), "Could not open the documents controls.");
        const supprimer = () => agir(async () => {
            const nom = app.name || app.bundleID || "this app";
            if (installee) {
                const choice = await documentDialog(app, true);
                if (!choice) return;
                const { apps } = await pont.postMessage({ action: "appsCatalog" });
                const actuelle = apps.find(a => a.id === app.id);
                if (!item.isConnected) return;
                if (!actuelle?.installedAt || actuelle.activeJob) {
                    informer("The app’s status changed. Review it and try again.");
                    gestion.relire();
                    return;
                }
                informer("Deleting app…");
                await requete("delete_app", { app_id: app.id }, AbortSignal.timeout(120000));
                gestion.retirer(app.id, item, choice === "backedUp" ? "Documents backed up. App deleted." : "App deleted.");
                return;
            }
            if (!window.confirm(`Remove the installation attempt for ${nom}? This also clears its history in SideRelay.`)) return;
            informer("Removing attempt…");
            const { removed } = await pont.postMessage({ action: "discardInstallAttempt", appID: app.id });
            if (removed) gestion.retirer(app.id, item, "Installation attempt removed.");
            else {
                informer("The app’s status changed. Review it and try again.");
                gestion.relire();
            }
        }, installee ? "Could not delete the app. Check that its device is reachable." : "Could not remove the attempt. Try again.");
        if (installee) {
            const nom = app.name || app.bundleID;
            let miseAJour, etatMiseAJour;
            const principale = bouton("Refresh Now", () => {
                if (app.activeJob || gestion.enCours.has(app.id)) return;
                if (miseAJour || etatMiseAJour) {
                    return agir(() => gestion.lancerMiseAJour(app, miseAJour), "Could not start the update.");
                }
                return renouveler?.();
            }, "btn btn-secondary sr-app-primary");
            const actualiserAction = () => {
                miseAJour = gestion.miseAJour(app);
                etatMiseAJour = gestion.etatMiseAJour(app, miseAJour);
                const afficheMiseAJour = Boolean(miseAJour || etatMiseAJour);
                principale.hidden = !afficheMiseAJour && !renouveler;
                principale.classList.toggle("btn-primary", afficheMiseAJour);
                principale.classList.toggle("btn-secondary", !afficheMiseAJour);
                if (afficheMiseAJour) gestion.afficherMiseAJour(principale, app, miseAJour, etatMiseAJour);
                else {
                    delete principale.dataset.updateState;
                    if (principale.textContent !== "Refresh Now") principale.textContent = "Refresh Now";
                    principale.title = `Refresh ${nom} now`;
                    principale.setAttribute("aria-label", principale.title);
                    principale.disabled = Boolean(app.activeJob);
                }
                if (gestion.enCours.has(app.id)) principale.disabled = true;
            };
            gestion.actionsPrincipales.set(item, actualiserAction);
            actualiserAction();
            const more = bouton("⋯", async control => {
                if (control.dataset.menuOpen) return;
                control.dataset.menuOpen = "1";
                const rect = control.getBoundingClientRect();
                try {
                    const action = await pont.postMessage({
                        action: "installedAppActions", x: String(rect.left), y: String(Math.min(rect.bottom, window.innerHeight)),
                        refresh: (miseAJour || etatMiseAJour) && renouveler ? "1" : "0",
                    });
                    if (!item.isConnected) return;
                    if (action === "refresh") await renouveler?.();
                    if (action === "versions") await gestion.versions(app);
                    if (action === "profiles") globalThis.sideRelayCatalogue.profiles(app, control);
                    if (action === "documents") await documents();
                    if (action === "delete") await supprimer();
                } catch { informer("Could not open the app action."); }
                finally { delete control.dataset.menuOpen; }
            }, "sr-link sr-app-more");
            more.setAttribute("aria-label", `More actions for ${nom}`);
            more.setAttribute("aria-haspopup", "menu");
            more.title = "More Actions";
            controles.push(principale, more);
            barre.append(principale, more);
            entete.append(barre);
        } else {
            const remove = bouton("Remove Attempt…", supprimer, "sr-link sr-app-delete");
            controles.push(remove);
            barre.append(remove);
            pied.append(barre);
        }
        pied.append(statut);
        afficherRetour();
        return pied;
    }

    function ligneApp(app, gestion) {
        const item = element("article", "", "sr-app-item");
        const installee = Boolean(app.installedAt) && !app.liveContainer;
        const compacte = installee || app.liveContainer;
        const nom = app.name || app.bundleID || "Unnamed App";
        if (app.id) item.dataset.srAppId = app.id;
        if (app.liveContainer) item.dataset.srLiveContainer = "";
        item.dataset.srSortName = app.name || app.bundleID || "";
        const entete = element("div", "", "sr-app-title");
        const identite = element("div", "", "sr-app-identity");
        const icone = element("span", "", "sr-library-icon");
        icone.setAttribute("aria-hidden", "true");
        icone.append(element("span"));
        const noms = element("div", "", "sr-app-names");
        const titre = element("div", "", "sr-app-name-line");
        const nomApp = element(compacte ? "h3" : "h2", installee ? "" : nom);
        if (compacte) {
            titre.append(nomApp);
            noms.append(titre);
        } else noms.append(nomApp);
        identite.append(icone, noms);
        entete.append(identite);
        if (app.icon) gestion.afficherIcone(icone, app.icon);
        else if (!app.liveContainer && app.installedAt && app.id) gestion.chargerIcone(icone, app.id);
        const etiquettes = element("div", "", "sr-app-tags");
        const versionComplete = globalThis.sideRelayCatalogue.installedVersion(app);
        if (versionComplete && !compacte) etiquettes.append(element("span", `Version ${versionComplete}`, "muted"));
        if (app.liveContainer) etiquettes.append(element("span", "LiveContainer", "job-badge sr-livecontainer-badge"));
        else {
            const [etat, classeEtat] = etatApp(app);
            if (etat !== "Installed") etiquettes.append(element("span", etat, `job-badge ${classeEtat}`));
        }
        if (etiquettes.hasChildNodes()) noms.append(etiquettes);
        if (!app.installedAt && !app.liveContainer && app.bundleID) {
            noms.append(element("p", app.bundleID, "muted sr-app-id"));
        }
        const details = element("dl", "", "sr-app-details");
        function ajouter(liste, nom, valeur, classe) {
            const paire = element("div", "", classe);
            paire.append(element("dt", nom));
            const definition = element("dd");
            definition.append(valeur instanceof Node ? valeur : document.createTextNode(valeur));
            paire.append(definition);
            liste.append(paire);
        }
        let appareil = app.device || "Unknown device";
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(app.deviceID || "")) {
            appareil = element("a", appareil);
            appareil.href = "/devices/" + app.deviceID;
        }
        item.append(entete);
        if (compacte) {
            const appareilLigne = element("p", "", "sr-app-device");
            appareilLigne.append(appareil);
            if (versionComplete) {
                const point = element("span", "·", "sr-app-meta-separator");
                point.setAttribute("aria-hidden", "true");
                const version = element("span", versionComplete, "sr-app-row-version");
                version.setAttribute("aria-label", `Version ${versionComplete}`);
                appareilLigne.append(point, version);
            }
            noms.insertBefore(appareilLigne, etiquettes.parentElement ? etiquettes : null);
        } else {
            ajouter(details, "Device", appareil, "sr-app-device-detail");
            item.append(details);
        }
        if (app.liveContainer) return item;
        const compte = element("span", app.account || "Not available", "sr-app-account-address");
        if (app.account) compte.title = app.account;
        ajouter(details, "Apple Account", compte, "sr-app-account-detail");
        let informations;
        if (installee) {
            const echeance = element("dl", "", "sr-app-row-expiration");
            const [libelle, valeur] = echeanceSignature(app.profileExpiresAt);
            ajouter(echeance, libelle, valeur);
            entete.append(echeance);

            if (app.bundleID) ajouter(details, "Bundle ID", app.bundleID);
            ajouter(details, "Installed", dateApp(app.installedAt));
            ajouter(details, "Last Refreshed", dateApp(app.refreshedAt));
            informations = element("div", "", "sr-app-disclosure");
            informations.id = `sr-app-details-${app.id}`;
            const detailsOuverts = gestion.detailsOuverts;
            const afficherDetails = ouvert => {
                informations.hidden = !ouvert;
                bascule.setAttribute("aria-expanded", String(ouvert));
            };
            const bascule = bouton(nom, () => {
                if (informations.hidden) detailsOuverts.add(app.id);
                else detailsOuverts.delete(app.id);
                afficherDetails(detailsOuverts.has(app.id));
            }, "sr-app-disclosure-toggle");
            bascule.setAttribute("aria-label", `${nom}, app details`);
            bascule.setAttribute("aria-controls", informations.id);
            nomApp.append(bascule);
            informations.append(details);
            afficherDetails(detailsOuverts.has(app.id));
            item.append(informations);
        }
        if (app.signingRepair) {
            const conseil = app.canRefresh
                ? "SideRelay will retry with the saved IPA when the device is reachable."
                : "Import the original IPA to re-sign this app.";
            item.append(element("p", conseil, "sr-app-issue"));
        }
        const { typeErreur, messageErreur } = globalThis.sideRelayJobs;
        if (app.latestError) {
            const defaut = app.latestJobKind === "install" ? "Installation failed."
                : app.latestJobKind === "re-sign" ? "Re-signing failed." : "Refresh failed.";
            const raison = messageErreur(app.latestError, defaut);
            const avis = element("p", raison, "sr-app-issue");
            item.append(avis);
            if (typeErreur(app.latestError) === "certificate-limit") {
                item.append(bouton("Review Certificates…", () => examinerCertificats(app.latestJobID),
                    "btn btn-sm btn-secondary sr-app-install-log"));
            }
            item.append(bouton("View Operation Log…", async () => {
                try { await pont.postMessage({ action: "installLogs", jobID: app.latestJobID }); }
                catch { avis.textContent = raison + " Could not open the operation log."; }
            }, "btn btn-sm btn-secondary sr-app-install-log"));
        }
        if (app.id) item.append(commandesApp(app, gestion, item, entete, informations));
        return item;
    }

    const comparerNoms = (a, b) => a.localeCompare(b, undefined, { sensitivity: "base" });

    function afficherCatalogue(contenu, apps, invites, gestion) {
        const installes = [...apps.filter(app => app.installedAt), ...invites.map(app => ({ ...app, liveContainer: true }))];
        installes.sort((a, b) => comparerNoms(a.name || a.bundleID || "", b.name || b.bundleID || ""));

        if (!apps.length && !installes.length) {
            contenu.replaceChildren(element("p", "No apps installed with SideRelay yet.", "muted sr-app-empty"));
            return;
        }
        const tentatives = apps.filter(app => !app.installedAt);
        const sections = [];
        for (const [titre, liste] of [["Installed Apps", installes], ["Installation Attempts", tentatives]]) {
            if (!liste.length) continue;
            const section = element("section", "", "sr-app-group");
            if (liste === installes) section.dataset.srInstalledList = "";
            section.append(element("h2", titre, "sr-app-group-title"));
            if (liste === installes) {
                const colonnes = element("div", "", "sr-installed-columns");
                colonnes.setAttribute("aria-hidden", "true");
                colonnes.append(element("span", "App"), element("span", "Signature Expires"));
                section.append(colonnes);
            }
            section.append(...liste.map(app => ligneApp(app, gestion)));
            sections.push(section);
        }
        contenu.replaceChildren(...sections);
    }

    function catalogue(main) {
        const panneau = element("section", "", "sr-app-catalog");
        const entete = element("div", "", "page-header sr-app-catalog-header");
        const titre = element("h1", "Apps");
        entete.append(titre);
        const contenu = element("div", "", "sr-app-content");
        contenu.setAttribute("aria-live", "polite");
        const statut = element("p", "", "sr-app-action-status");
        statut.setAttribute("role", "status");
        panneau.append(entete);
        const installees = element("div");
        globalThis.sideRelayAppInstaller(installees, charger,
            (paquets, lot) => bibliotheque.reviewBatch(paquets, lot));
        const statutInvites = element("p", "", "sr-app-action-status sr-app-library-note");
        statutInvites.setAttribute("role", "status");
        const inbox = element("section", "", "sr-app-group sr-app-inbox");
        inbox.hidden = true;
        installees.append(statut, statutInvites, inbox, contenu);
        const vues = element("div");
        vues.append(installees);
        panneau.append(vues);
        let actualisationEnCours = false;
        let dernieresApps = [];
        let invites = [];
        const bibliotheque = globalThis.sideRelayCatalogue.mount(vues, installees, inbox, charger,
            () => !actualisationEnCours, () => {
                for (const ligne of contenu.querySelectorAll("[data-sr-installed-list] > .sr-app-item")) {
                    gestion.actionsPrincipales.get(ligne)?.();
                }
            }, () => [...dernieresApps.filter(app => app.installedAt), ...invites.map(app => ({ ...app, liveContainer: true }))], entete);
        let lecture = 0;
        let aRelire = false;
        let catalogueCharge = false;
        const chargerIcones = new IntersectionObserver(entries => {
            for (const { target, isIntersecting } of entries) {
                if (!isIntersecting) continue;
                chargerIcones.unobserve(target);
                void pont.postMessage({ action: "installedAppIcon", appID: target.dataset.srIconApp })
                    .then(({ png }) => gestion.afficherIcone(target, png)).catch(() => {});
            }
        });
        const gestion = {
            versions: app => bibliotheque.versions(app),
            miseAJour: bibliotheque.updateFor,
            lancerMiseAJour: bibliotheque.updateInstalled,
            etatMiseAJour: bibliotheque.updateState,
            afficherMiseAJour: bibliotheque.updateAppearance,
            actionsPrincipales: new WeakMap(),
            enCours: new Set(),
            retours: new Map(),
            detailsOuverts: new Set(),
            afficherIcone(cible, png) {
                if (!png) return;
                const image = element("img");
                image.alt = "";
                image.addEventListener("load", () => cible.replaceChildren(image), { once: true });
                image.src = `data:image/png;base64,${png}`;
            },
            chargerIcone(cible, id) {
                cible.dataset.srIconApp = id;
                chargerIcones.observe(cible);
            },
            relire() { aRelire = true; },
            reprendre() { if (aRelire && !gestion.enCours.size) void charger(); },
            retirer(id, carte, texte) {
                gestion.retours.delete(id);
                gestion.detailsOuverts.delete(id);
                statut.textContent = texte;
                // Keep the other cards mounted while their commands are running.
                const groupe = carte.parentElement;
                carte.remove();
                if (!groupe?.querySelector(".sr-app-item")) groupe?.remove();
                gestion.relire();
            },
        };
        async function charger() {
            if (!panneau.isConnected) return;
            if (gestion.enCours.size) { gestion.relire(); return; }
            aRelire = false;
            const demande = ++lecture;
            actualisationEnCours = true;
            if (!contenu.hasChildNodes()) contenu.replaceChildren(element("p", "Loading…", "muted"));
            try {
                const donnees = await pont.postMessage({ action: "appsCatalog" });
                if (!panneau.isConnected || demande !== lecture) return;
                if (gestion.enCours.size) { gestion.relire(); return; }
                rendre(donnees.apps);
                void chargerInvites(demande, donnees.apps);
                void bibliotheque.refresh().then(() => {
                    if (panneau.isConnected && demande === lecture) return bibliotheque.checkSources();
                });
                catalogueCharge = true;
                if (statut.textContent === "Could not load the list of apps.") statut.textContent = "";
            } catch {
                if (panneau.isConnected && demande === lecture) {
                    statut.textContent = "Could not load the list of apps.";
                    if (!catalogueCharge) contenu.replaceChildren();
                }
            } finally { if (demande === lecture) actualisationEnCours = false; }
        }
        function rendre(apps) {
            dernieresApps = apps;
            bibliotheque.renderInbox();
            const focus = document.activeElement;
            const id = focus?.closest("[data-sr-app-id]")?.dataset.srAppId;
            const label = focus?.textContent;
            const tag = focus?.tagName;
            chargerIcones.disconnect();
            afficherCatalogue(contenu, apps, invites, gestion);
            if (id) {
                const card = contenu.querySelector(`[data-sr-app-id="${CSS.escape(id)}"]`);
                const nom = focus.getAttribute("aria-label");
                [...(card?.querySelectorAll("button, input, a, summary") || [])]
                    .find(control => control.tagName === tag && control.textContent === label &&
                        control.getAttribute("aria-label") === nom)?.focus({ preventScroll: true });
            }
        }
        async function chargerInvites(demande, apps) {
            const actuel = () => panneau.isConnected && demande === lecture;
            try {
                const resultat = await pont.postMessage({ action: "liveContainerInventory" });
                if (!actuel()) return;
                statutInvites.textContent = resultat.incomplete
                    ? "Could not check all LiveContainer apps. Connect and unlock your device, then use More → Refresh List."
                    : "";
                // An unreachable device gives no evidence that its apps were removed.
                if (resultat.incomplete && invites.length) return;
                const suivants = JSON.stringify(resultat.apps);
                if (suivants === JSON.stringify(invites)) return;
                invites = resultat.apps;
                bibliotheque.renderInbox();
                const groupe = contenu.querySelector("[data-sr-installed-list]");
                // Keep focus, open disclosures and running actions on the native rows.
                if (!groupe) { rendre(apps); return; }
                groupe.querySelectorAll("[data-sr-live-container]").forEach(row => row.remove());
                if (!invites.length && !groupe.querySelector(".sr-app-item")) { rendre(apps); return; }
                for (const invite of invites) {
                    const row = ligneApp({ ...invite, liveContainer: true }, gestion);
                    const next = [...groupe.querySelectorAll(".sr-app-item")]
                        .find(other => comparerNoms(row.dataset.srSortName, other.dataset.srSortName) < 0);
                    groupe.insertBefore(row, next || null);
                }
            } catch {
                if (actuel()) statutInvites.textContent = "Could not check LiveContainer apps. Use More → Refresh List to try again.";
            }
        }
        main.append(panneau);
        bibliotheque.watchInbox();
        globalThis.sideRelayAppsChanged = charger;
        void charger();
    }

    function lien(texte, adresse, classe = "btn btn-secondary") {
        const a = element("a", texte, classe);
        a.href = adresse;
        return a;
    }

    function bouton(texte, action, classe = "btn btn-secondary") {
        const b = element("button", texte, classe);
        b.type = "button";
        b.addEventListener("click", e => { if (e.isTrusted) void action(b); });
        return b;
    }

    function commande(texte, action) {
        return bouton(texte, () => pont.postMessage({ action }).catch(() => {}));
    }

    function identifiantAppareil(valeur) {
        return String(valeur || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
    }

    function nomAppareil(valeur) {
        return String(valeur || "").normalize("NFKD").replace(/\p{Mark}/gu, "")
            .toLowerCase().replace(/[^\p{Letter}\p{Number}]/gu, "");
    }

    function appareilsAJumeler(source, appareils, enregistres) {
        const wifi = source === "wifi";
        return appareils.filter(appareil => {
            if (source === "usb") {
                const id = identifiantAppareil(appareil.id);
                return !id || !enregistres.some(d => identifiantAppareil(d.udid) === id);
            }
            if (appareil.address && enregistres.some(d => [d.ip, d.mdns_ip].includes(appareil.address))) return false;
            if (!wifi) return true;
            // Bonjour and the registered name can differ in spacing, accents or apostrophes.
            // An ambiguous or generic name stays visible for pairing.
            const nom = nomAppareil(appareil.name);
            if (!nom || /^(?:iphone|ipad)(?:[0-9]+)?(?:air|mini|pro|max|promax|plus)?(?:[0-9]+)?$/.test(nom)) return true;
            return enregistres.filter(d => nomAppareil(d.name) === nom).length !== 1
                || appareils.filter(d => nomAppareil(d.name) === nom).length !== 1;
        });
    }

    function ajouterIPhone(main) {
        const champ = main.querySelector('input[name="pairing_blob_b64"]');
        const formulaire = champ?.form;
        const carte = champ?.closest(".card");
        if (!formulaire || !carte || carte.classList.contains("sr-device-add")) return;
        const page = carte.parentElement;
        const ip = formulaire.querySelector('input[name="ip"]');
        const fichier = formulaire.querySelector('input[type="file"]');
        const valider = formulaire.querySelector('button[type="submit"]');
        if (!ip || !fichier || !valider) return;

        carte.classList.add("sr-device-add");
        const boite = element("dialog", "", "sr-pair-dialog sr-pair-import");
        const titreFormulaire = carte.querySelector("h2");
        titreFormulaire.textContent = "Import Pairing File";
        titreFormulaire.id = "sr-pair-import-title";
        titreFormulaire.tabIndex = -1;
        boite.setAttribute("aria-labelledby", titreFormulaire.id);
        const conseil = element("p", "Select your iPhone, then choose its pairing file.", "sr-pair-intro");
        const feedback = element("p", "", "sr-feedback");
        feedback.setAttribute("role", "status");
        const fermer = bouton("Cancel", () => boite.close());
        const aide = element("details", "", "sr-pairing-details");
        const ouvrir = bouton("Open Pairing Tool…", async b => {
            b.disabled = true;
            feedback.textContent = "";
            try { await pont.postMessage({ action: "openPairingTool" }); }
            catch { feedback.textContent = "Could not open the pairing tool. Try again or open idevice_pair.dmg from the SideRelay folder."; }
            finally { b.disabled = false; }
        });
        aide.append(element("summary", "Recover a pairing from the old tool"),
            element("p", "If the external tool is still open with a paired device, select it and click Save to file… Then choose that file here."), ouvrir);
        const actionsFormulaire = element("div", "", "sr-pair-actions");
        actionsFormulaire.append(fermer, valider);
        const adressesTrouvees = element("label", "iPhone connection", "form-field sr-device-addresses");
        const choixAdresse = document.createElement("select");
        choixAdresse.required = true;
        const aideAdresse = element("small");
        aideAdresse.id = "sr-pair-import-address-help";
        aideAdresse.setAttribute("role", "status");
        choixAdresse.setAttribute("aria-describedby", aideAdresse.id);
        const rescanner = bouton("Scan Again", rechercher, "sr-link");
        const aideReseau = element("div", "", "sr-device-address-help");
        aideReseau.append(aideAdresse, rescanner);
        const etiquetteIP = ip.closest("label");
        etiquetteIP.classList.add("sr-device-ip");
        const adresseManuelle = "manual";
        let saisieManuelle = false;
        adressesTrouvees.append(choixAdresse);
        choixAdresse.addEventListener("change", () => {
            saisieManuelle = choixAdresse.value === adresseManuelle;
            adresse(saisieManuelle ? "" : choixAdresse.value);
            etiquetteIP.hidden = !saisieManuelle;
            aideReseau.hidden = saisieManuelle || !aideAdresse.textContent;
            if (saisieManuelle) ip.focus();
        });
        formulaire.before(conseil);
        formulaire.prepend(adressesTrouvees, aideReseau);
        formulaire.append(aide, feedback, actionsFormulaire);
        const libelle = [...valider.childNodes].find(n => n.nodeType === Node.TEXT_NODE && /register/i.test(n.textContent));
        if (libelle) libelle.textContent = "Add Device";
        const etiquetteFichier = [...fichier.parentNode.childNodes].find(n => n.nodeType === Node.TEXT_NODE && /pairing/i.test(n.textContent));
        if (etiquetteFichier) etiquetteFichier.textContent = "Pairing file (.plist)";
        ip.placeholder = "iPhone’s IPv4 address";
        const liste = element("section", "", "sr-device-discovery");
        const entete = element("div", "", "sr-section-header");
        const titreDecouverte = element("h2", "Available Devices");
        entete.append(titreDecouverte);
        const actions = element("div", "", "sr-actions");
        const actualiser = bouton("Scan Again", rechercher);
        let dernierBouton;
        const manuel = bouton("Import Pairing File…", afficherImport, "sr-link");
        manuel.setAttribute("aria-haspopup", "dialog");
        const sansFil = bouton("Pair over Wi-Fi…", b => ouvrirJumelage(b, "wifi"), "btn btn-primary");
        actions.append(sansFil, actualiser);
        entete.append(actions);
        const resultatRecherche = element("p", "", "sr-device-empty sr-device-scan-status");
        resultatRecherche.setAttribute("role", "status");
        liste.append(entete, resultatRecherche);
        const groupes = {};
        for (const [cle, titre] of [["usb", "USB"], ["wifi", "Local Network · Bonjour"], ["tailscale", "Tailscale"]]) {
            const section = element("section", "", "sr-device-group");
            const lignes = element("div", "", "sr-device-rows");
            lignes.setAttribute("aria-live", "polite");
            section.append(element("h3", titre), lignes);
            liste.append(section);
            groupes[cle] = lignes;
        }
        const appleTV = element("section", "", "sr-device-group");
        const tvList = element("div", "", "sr-device-rows");
        tvList.setAttribute("aria-live", "polite");
        appleTV.append(element("h3", "Apple TV · Local Network"), tvList);
        liste.append(appleTV);

        function afficherAppleTV(result) {
            if (setup()) { appleTV.hidden = true; return; }
            appleTV.hidden = false;
            if (result.status !== "fulfilled") {
                tvList.replaceChildren(element("p", "Apple TV discovery requires Xcode. Check that Xcode is installed and open Devices and Simulators to pair the Apple TV.", "sr-device-empty"));
                return;
            }
            const devices = result.value.filter(tv => !appareilsConnus.some(device => device.udid === tv.udid));
            if (result.value.length && !devices.length) {
                appleTV.hidden = true;
                return;
            }
            if (!devices.length) {
                tvList.replaceChildren(element("p", "To add an Apple TV, pair it in Xcode on this Mac, then scan again.", "sr-device-empty"));
                return;
            }
            tvList.replaceChildren(...devices.map(tv => {
                const row = element("div", "", "sr-device-row");
                const details = element("div", "", "sr-device-identity");
                details.append(element("strong", tv.name), element("small", tv.osVersion ? `tvOS ${tv.osVersion} · Paired in Xcode` : "Paired in Xcode"));
                const add = bouton("Add Apple TV", async control => {
                    control.disabled = true;
                    try {
                        await globalThis.sideRelayJobs.requete("apple_tv_devices", { udid: tv.udid }, AbortSignal.timeout(18000));
                        location.reload();
                    } catch (error) {
                        resultatRecherche.textContent = lireErreur(error) || "Could not add the Apple TV. Scan again to retry.";
                        control.disabled = false;
                    }
                });
                add.setAttribute("aria-label", `Add Apple TV · ${tv.name}`);
                row.append(details, add);
                return row;
            }));
        }
        const avance = element("details", "", "sr-device-advanced");
        avance.append(element("summary", "Advanced"), manuel);
        liste.append(avance);
        const enregistres = [...page.querySelectorAll(":scope > .card")].find(s => s !== carte);
        if (enregistres) {
            enregistres.classList.add("sr-device-registered");
            const h2 = enregistres.querySelector("h2");
            if (h2) h2.textContent = "My Devices";
            enregistres.after(liste);
        } else {
            carte.before(liste);
        }
        carte.before(boite);
        boite.append(carte);
        boite.addEventListener("close", () => {
            if (dernierBouton?.isConnected) dernierBouton.focus({ preventScroll: true });
            dernierBouton = undefined;
        });

        function adresse(valeur) {
            if (ip.value === valeur) return;
            ip.value = valeur;
            ip.dispatchEvent(new Event("input", { bubbles: true }));
            ip.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function afficherImport(b) {
            if (document.querySelector("dialog[open]")) return;
            dernierBouton = b;
            feedback.textContent = "";
            proposerAdresses();
            aide.open = false;
            boite.showModal();
            titreFormulaire.focus({ preventScroll: true });
        }

        const aucun = {
            usb: "No iPhone or iPad connected. Plug it in, unlock it and tap Trust if asked.",
            wifi: "No devices found. Keep the iPhone unlocked on the same network, then scan again.",
            tailscale: "No iPhone or iPad found. Connect the iPhone to the same Tailscale account as this Mac.",
        };
        const indisponible = {
            usb: "USB detection failed. Try scanning again.",
            wifi: "Local network discovery is unavailable. Try scanning again.",
            tailscale: "Could not read Tailscale. Check that it’s connected on this Mac, or add the address manually.",
        };
        const inventaireReseau = {};
        let appareilsConnus = [];
        let inventaireDisponible = false;
        let rechercheEnCours;
        let relancerRecherche = false;
        const setup = () => document.documentElement.dataset.srView === "setup-0";
        function adressesDisponibles() {
            const sources = document.documentElement.dataset.srConnection === "tailscale"
                ? ["tailscale", "wifi"] : ["wifi", "tailscale"];
            return sources.flatMap(source => (inventaireReseau[source] || [])
                .filter(a => source !== "tailscale" || a.online)
                .map(a => ({ ...a, source })));
        }

        async function ouvrirJumelage(b, mode, appareil, ipChoisie) {
            if (rechercheEnCours) {
                const texte = b.textContent;
                b.disabled = true;
                b.textContent = "Finding iPhone addresses…";
                try { await rechercheEnCours; }
                finally {
                    b.disabled = false;
                    b.textContent = b === sansFil && appareilsConnus.length ? "Pair Another iPhone…" : texte;
                }
            }
            if (!inventaireDisponible || !liste.isConnected) return;
            const connexion = document.documentElement.dataset.srConnection;
            return globalThis.sideRelayPair({ mode, appareil, adresses: adressesDisponibles(), adresse: ipChoisie, connexion });
        }

        function proposerAdresses() {
            const adresses = adressesDisponibles();
            const connexion = document.documentElement.dataset.srConnection;
            const sourcePreferee = connexion === "tailscale" ? "tailscale" : "wifi";
            const preferees = adresses.filter(a => a.source === sourcePreferee);
            const options = adresses.map(appareil => {
                const mode = appareil.source === "wifi" ? "Local network" : "Tailscale";
                const option = element("option", `${appareil.name} · ${mode} · ${appareil.address}`);
                option.value = appareil.address;
                return option;
            });
            const invitation = element("option", "Select your iPhone…");
            invitation.value = "";
            const manuel = element("option", "Enter an IP address manually…");
            manuel.value = adresseManuelle;
            choixAdresse.replaceChildren(invitation, ...options, manuel);
            if (!saisieManuelle && !ip.value && preferees.length === 1) adresse(preferees[0].address);
            choixAdresse.value = saisieManuelle ? adresseManuelle : options.some(option => option.value === ip.value) ? ip.value : "";
            if (!saisieManuelle && choixAdresse.value === "" && ip.value) adresse("");
            etiquetteIP.hidden = !saisieManuelle;
            rescanner.disabled = Boolean(rechercheEnCours);
            aideAdresse.textContent = preferees.length ? "" : rechercheEnCours ? "Finding iPhone addresses…"
                : connexion === "tailscale" ? "Connect Tailscale on your iPhone, then scan again."
                : "Keep your iPhone on the same network, then scan again.";
            aideReseau.hidden = saisieManuelle || !aideAdresse.textContent;
        }

        function afficher(cle, resultat) {
            const cible = groupes[cle];
            const listeAppareils = appareilsAJumeler(cle, resultat.devices || [], appareilsConnus);
            inventaireReseau[cle] = listeAppareils;
            cible.parentElement.hidden = appareilsConnus.length > 0 && !listeAppareils.length && resultat.status === "ready";
            if (!listeAppareils.length) {
                const message = resultat.status === "permission"
                    ? "Allow SideRelay in System Settings → Privacy & Security → Local Network, then scan again."
                    : resultat.status === "ready" ? aucun[cle] : indisponible[cle];
                cible.replaceChildren(element("p", message, "sr-device-empty"));
                return;
            }
            const lignes = listeAppareils.map(appareil => {
                const ligne = element("div", "", "sr-device-row");
                const details = element("div", "", "sr-device-identity");
                const etat = cle === "usb" ? "Connected by USB" : cle === "tailscale"
                    ? appareil.online ? "Online" : "Offline"
                    : appareil.remotePairing ? "Remote pairing available" : "Visible on the local network";
                const detail = appareil.address ? `${etat} · ${appareil.address}` : etat;
                details.append(element("strong", appareil.name), element("small", detail));
                const texte = cle === "usb" ? "Pair via USB…" : "Pair…";
                const action = bouton(texte, b => {
                    if (cle === "usb") return ouvrirJumelage(b, "usb", appareil);
                    if (cle === "wifi") return ouvrirJumelage(b, "wifi", appareil, appareil.address);
                    const cable = inventaireReseau.usb || [];
                    if (cable.length === 1) return ouvrirJumelage(b, "usb", cable[0], appareil.address);
                    return ouvrirJumelage(b, "wifi", appareil, appareil.address);
                });
                if (setup() && cle === "usb") action.classList.add("btn-primary");
                action.setAttribute("aria-label", `${texte} · ${appareil.name}`);
                ligne.append(details, action);
                return ligne;
            });
            cible.replaceChildren(...lignes);
        }

        function rechercher() {
            if (!liste.isConnected) return;
            if (rechercheEnCours) return rechercheEnCours;
            actualiser.disabled = true;
            resultatRecherche.textContent = "Looking for devices…";
            for (const cible of Object.values(groupes)) cible.parentElement.hidden = true;
            const erreur = { status: "unavailable", devices: [] };
            rechercheEnCours = Promise.allSettled([
                pont.postMessage({ action: "deviceInventory" }),
                pont.postMessage({ action: "nearbyDevices" }),
                setup() ? Promise.resolve([]) : globalThis.sideRelayJobs.requete("apple_tv_devices", {}, AbortSignal.timeout(11000)),
            ]).then(([inventaire, bonjour, tv]) => {
                if (!liste.isConnected) return;
                inventaireDisponible = inventaire.status === "fulfilled" && Array.isArray(inventaire.value.registered);
                if (!inventaireDisponible) {
                    resultatRecherche.textContent = "Could not check which devices are already paired. Click Scan Again to retry.";
                    for (const cle of Object.keys(inventaireReseau)) delete inventaireReseau[cle];
                    return;
                }
                appareilsConnus = inventaire.value.registered;
                afficherAppleTV(tv);
                const resultats = {
                    usb: inventaire.value.usb || erreur,
                    wifi: bonjour.status === "fulfilled" ? bonjour.value : erreur,
                    tailscale: inventaire.value.tailscale || erreur,
                };
                for (const [cle, resultat] of Object.entries(resultats)) afficher(cle, resultat);
                const nouveaux = Object.values(inventaireReseau).some(appareils => appareils.length > 0) ||
                    (tv.status === "fulfilled" && tv.value.some(device => !appareilsConnus.some(saved => saved.udid === device.udid)));
                const complet = Object.values(resultats).every(resultat => resultat.status === "ready");
                const cable = inventaireReseau.usb?.length > 0;
                sansFil.className = setup() && cable ? "btn btn-secondary" : "btn btn-primary";
                resultatRecherche.textContent = setup()
                    ? appareilsConnus.length ? "Your iPhone is paired. Continue when you’re ready."
                        : cable ? "USB recommended. Choose Pair via USB next to your iPhone."
                        : "No USB connection detected. Connect your iPhone, or use Pair over Wi-Fi on the same local network."
                    : appareilsConnus.length && !nouveaux && complet ? "No new devices found." : "";
            }).finally(() => {
                rechercheEnCours = null;
                if (!liste.isConnected) return;
                proposerAdresses();
                titreDecouverte.textContent = appareilsConnus.length ? "Add a Device" : "Available Devices";
                sansFil.textContent = appareilsConnus.length ? "Pair Another iPhone…" : "Pair over Wi-Fi…";
                sansFil.disabled = !inventaireDisponible;
                actualiser.disabled = false;
                if (relancerRecherche) {
                    relancerRecherche = false;
                    void rechercher();
                }
            });
            proposerAdresses();
            return rechercheEnCours;
        }
        if (enregistres) {
            const miseAJour = new MutationObserver(() => {
                if (!liste.isConnected) { miseAJour.disconnect(); return; }
                if (rechercheEnCours) relancerRecherche = true;
                else void rechercher();
            });
            miseAJour.observe(enregistres, { childList: true, subtree: true, characterData: true });
        }
        void rechercher();
        if (setup()) {
            let signatureUSB;
            async function surveillerCable() {
                if (!liste.isConnected || !setup()) return;
                if (!rechercheEnCours && !document.querySelector("dialog[open]")) {
                    try {
                        const signature = JSON.stringify(await pont.postMessage({ action: "setupUSB" }));
                        if (signature !== signatureUSB) {
                            signatureUSB = signature;
                            void rechercher();
                        }
                    } catch { /* The manual scan still works when polling is unavailable. */ }
                }
                setTimeout(surveillerCable, 2500);
            }
            setTimeout(surveillerCable, 2500);
        }
    }

    function deviceList(main) {
        const table = main.querySelector(".sr-device-registered .table");
        if (!table) return;
        table.classList.add("sr-device-list-table");
        for (const row of table.tBodies[0]?.rows || []) {
            const name = row.cells[0];
            const actions = row.cells[row.cells.length - 1];
            const manage = actions?.querySelector('a[href^="/devices/"]');
            if (name && manage) {
                manage.className = "sr-device-list-link";
                manage.replaceChildren(...name.childNodes);
                name.append(manage);
                row.classList.add("sr-device-link-row");
            }
            const original = actions?.querySelector("form button.btn-danger");
            if (!original || actions.querySelector(".sr-device-list-more")) continue;
            const more = bouton("More", async control => {
                if (control.dataset.menuOpen || original.disabled) return;
                control.dataset.menuOpen = "1";
                const rect = control.getBoundingClientRect();
                try {
                    const action = await pont.postMessage({
                        action: "deviceListActions", x: String(rect.left), y: String(rect.bottom),
                    });
                    if (action === "remove" && original.isConnected && !original.disabled) original.click();
                } catch {}
                finally { delete control.dataset.menuOpen; }
            }, "btn btn-secondary sr-toolbar-menu sr-device-list-more");
            more.setAttribute("aria-label", `More actions for ${name.textContent.trim()}`);
            more.setAttribute("aria-haspopup", "menu");
            original.closest("form").hidden = true;
            actions.append(more);
        }
        presenterAppareils(table, [...table.querySelectorAll(".sr-device-list-link")]);
    }

    const appareilsPresentes = new WeakSet();
    let overviewRefresh;

    function overviewRefreshState(grid) {
        if (!grid || overviewRefresh?.grid === grid) return;
        clearTimeout(overviewRefresh?.timer);
        for (const old of grid.querySelectorAll(".sr-overview-refresh, .sr-overview-refresh-toggle, .sr-overview-refresh-warning")) old.remove();
        const state = { grid };
        overviewRefresh = state;
        const jobs = globalThis.sideRelayJobs;
        const format = seconds => new Date(seconds * 1000).toLocaleString(undefined, {
            dateStyle: "medium", timeStyle: "short",
        });
        const rows = [];
        for (const link of grid.querySelectorAll(".sr-overview-device-link")) {
            const card = link.closest(".sr-overview-device-card");
            const count = card.querySelector(".device-summary > .summary-count");
            if (!count) continue;
            const id = link.pathname.split("/")[2];
            const panel = element("div", "", "sr-overview-refresh");
            panel.id = `sr-overview-refresh-${id}`;
            panel.setAttribute("popover", "auto");
            panel.setAttribute("role", "group");
            panel.setAttribute("aria-label", "Auto-Refresh Details");
            const toggle = element("button", "Auto-Refresh…", "sr-app-disclosure-toggle sr-overview-refresh-toggle");
            toggle.type = "button";
            toggle.setAttribute("popovertarget", panel.id);
            panel.addEventListener("beforetoggle", event => {
                if (event.newState !== "open") return;
                const anchor = toggle.getBoundingClientRect();
                const above = innerHeight - anchor.bottom < 180 && anchor.top > innerHeight / 2;
                panel.toggleAttribute("data-above", above);
                panel.style.setProperty("--refresh-anchor-right", `${anchor.right}px`);
                panel.style.setProperty("--refresh-anchor-y", `${above ? anchor.top - 6 : anchor.bottom + 6}px`);
            });
            const warning = element("p", "", "sr-overview-refresh-warning");
            const dates = element("dl");
            const last = element("dd");
            const next = element("dd");
            for (const [label, value] of [["Last Refresh", last], ["Next Expiry", next]]) {
                const row = element("div");
                row.append(element("dt", label), value);
                dates.append(row);
            }
            const connection = element("p", "", "muted");
            const check = bouton("Check Connection", async button => {
                button.disabled = true;
                button.textContent = "Checking…";
                connection.textContent = "";
                try {
                    const result = await jobs.requete("probe_device", { device_id: id }, AbortSignal.timeout(15000));
                    if (result.reachable_ms == null) connection.textContent = advice(card.hasAttribute("data-sr-tv"));
                } catch {
                    connection.textContent = advice(card.hasAttribute("data-sr-tv"));
                } finally {
                    button.textContent = "Check Connection";
                    button.disabled = false;
                }
            });
            connection.setAttribute("role", "status");
            panel.append(dates, check, connection);
            count.after(toggle);
            count.parentElement.append(warning, panel);
            rows.push({ id, card, toggle, dates, last, next, warning });
        }
        function advice(tv) {
            return tv ? "Wake the Apple TV and check that it’s on the same network as your Mac."
                : "Reconnect the iPhone to Wi-Fi with Tailscale active, or connect it by USB.";
        }
        function set(control, value) {
            if (control.textContent !== value) control.textContent = value;
        }
        async function read() {
            if (overviewRefresh !== state || !grid.isConnected) return;
            try {
                const apps = await globalThis.sideRelayCatalogue.installedApps();
                if (overviewRefresh !== state || !grid.isConnected) return;
                for (const { id, card, toggle, dates, last, next: expiry, warning: notice } of rows) {
                    const installed = apps.filter(app => app.deviceID === id && app.installedAt);
                    const enabled = installed.filter(app => app.autoRefresh);
                    const failures = enabled.filter(app => app.latestJobKind === "refresh" && app.latestError);
                    const next = enabled.filter(app => app.profileExpiresAt).sort((a, b) => a.profileExpiresAt - b.profileExpiresAt)[0];
                    const refreshed = Math.max(0, ...enabled.map(app => app.refreshedAt || 0));
                    const repair = enabled.find(app => app.signingRepair);
                    const missing = enabled.find(app => !app.accountID || app.ipaPresent === false);
                    const pairing = failures.some(app => jobs.typeErreur(app.latestError) === "pairing-unreachable");
                    const expired = next && next.profileExpiresAt * 1000 <= Date.now();
                    const failure = failures[0]?.latestError;
                    const warning = repair ? `Re-sign ${repair.name} in Apps.`
                        : missing && !missing.accountID ? "Reconnect the Apple Account."
                        : missing ? `Import the IPA for ${missing.name} again.`
                        : pairing ? advice(card.hasAttribute("data-sr-tv"))
                        : failure ? jobs.messageErreur(failure, "Last refresh failed. Open Activity for details.")
                        : expired ? `${next.name} has expired. Use Refresh All.` : "";
                    const status = warning ? "Issue" : enabled.some(app => app.activeJob === "refresh") ? "Running…"
                        : !enabled.length ? "Off" : enabled.length === installed.length ? "On" : `${enabled.length}/${installed.length}`;
                    set(toggle, `Auto-Refresh ${status}`);
                    toggle.hidden = !installed.length;
                    set(notice, warning);
                    dates.hidden = !enabled.length;
                    set(last, refreshed ? format(refreshed) : "None yet");
                    set(expiry, next ? `${next.name} · ${format(next.profileExpiresAt)}` : "Unknown");
                }
            } catch {
                if (grid.isConnected && overviewRefresh === state) {
                    for (const { toggle, dates, warning } of rows) {
                        toggle.hidden = false;
                        set(toggle, "Auto-Refresh Unavailable");
                        set(warning, "");
                        dates.hidden = true;
                    }
                }
            }
            if (overviewRefresh === state && grid.isConnected) state.timer = setTimeout(read, 30000);
        }
        void read();
    }

    function presenterAppareils(conteneur, liens) {
        if (!conteneur || appareilsPresentes.has(conteneur) || !liens.length) return;
        appareilsPresentes.add(conteneur);
        void globalThis.sideRelayJobs.requete("list_devices").then(appareils => {
            if (!conteneur.isConnected) return;
            const televisions = new Set(appareils.filter(globalThis.sideRelayIPAPlatforms.isAppleTV)
                .map(appareil => String(appareil.id)));
            for (const lien of liens) {
                lien.closest(".sr-overview-device-card, tr")?.toggleAttribute("data-sr-tv",
                    televisions.has(lien.pathname.split("/")[2]));
            }
        }).catch(() => {});
    }

    let seenRoute;
    let deviceDetails;

    function devicePage(main, path) {
        main.classList.add("sr-device-detail");
        const apps = main.querySelector('form[action^="/api/reconcile_apps"]')?.closest(".card");
        apps?.classList.add("sr-device-apps");
        const installRow = main.querySelector(".device-mgmt-row");
        const options = installRow?.closest(".card");
        if (options && !options.classList.contains("sr-device-options-card")) {
            const title = options.querySelector(":scope > h2");
            const control = bouton("Device Options", button => {
                const expanded = button.getAttribute("aria-expanded") === "true";
                button.setAttribute("aria-expanded", String(!expanded));
            }, "sr-device-options-disclosure");
            control.setAttribute("aria-expanded", "false");
            title?.replaceChildren(control);
            options.classList.add("sr-device-options-card");
            installRow.classList.add("sr-device-install-row");
        }

        if (deviceDetails?.path !== path) {
            main.removeAttribute("data-sr-tv-device");
            deviceDetails = { path };
            const pending = deviceDetails;
            void globalThis.sideRelayJobs.requete("get_device_info", { id: path.split("/")[2] }).then(device => {
                if (deviceDetails !== pending || location.pathname !== path) return;
                pending.device = device;
                devicePage(main, path);
            }).catch(() => {});
        }
        if (!deviceDetails.device) return;
        const isTV = globalThis.sideRelayIPAPlatforms.isAppleTV(deviceDetails.device);
        main.toggleAttribute("data-sr-tv-device", isTV);
        const info = main.querySelector(".info-table");
        for (const row of info?.rows || []) {
            const [label, value] = row.cells;
            if (label.textContent === "Discovery") {
                label.textContent = isTV ? "Pairing" : "Address Source";
                if (isTV) value.textContent = "Xcode";
                else if (value.textContent === "static") value.textContent = "Manual";
            } else if (isTV && label.textContent === "IP") {
                label.textContent = "Connection";
                value.textContent = "Local Network";
            } else if (isTV && label.textContent === "Port") {
                row.hidden = true;
            }
        }
    }

    async function examinerCertificats(jobID) {
        if (!jobID || document.querySelector(".sr-certificate-review")) return;
        const dialog = element("dialog", "", "sr-certificate-review");
        const titre = element("h2", "Replace an Apple Development Certificate");
        titre.id = "sr-certificate-title";
        dialog.setAttribute("aria-labelledby", titre.id);
        const contenu = element("div");
        const statut = element("p", "Reading certificates from Apple…");
        statut.setAttribute("role", "status");
        const actions = element("div", "", "sr-actions");
        const fermer = bouton("Cancel", () => dialog.close());
        actions.append(fermer);
        dialog.append(titre, contenu, statut, actions);
        document.body.append(dialog);
        dialog.addEventListener("close", () => dialog.remove(), { once: true });
        dialog.showModal();
        const lireErreur = erreur => {
            try {
                const donnees = JSON.parse(erreur.message || "");
                return donnees.ServerError || donnees.error || erreur.message;
            } catch { return erreur.message; }
        };
        try {
            const plan = await globalThis.sideRelayJobs.requete("review_certificate", { job_id: jobID }, AbortSignal.timeout(40000));
            if (!dialog.open) return;
            const selecteur = element("select");
            const etiquette = element("label", "Certificate to replace");
            etiquette.htmlFor = selecteur.id = "sr-certificate-choice";
            selecteur.append(new Option("Choose a certificate", ""));
            for (const certificat of plan.certificates) {
                selecteur.append(new Option(certificat.label, certificat.serial));
            }
            const impact = element("div");
            const avis = "Apps installed outside SideRelay may also stop opening.";
            let enCours = false;
            let terminee = false;
            const remplacer = bouton("Revoke and Replace…", async () => {
                const certificat = plan.certificates.find(entree => entree.serial === selecteur.value);
                if (!certificat || enCours) return;
                enCours = true;
                selecteur.disabled = remplacer.disabled = fermer.disabled = true;
                statut.textContent = "";
                try {
                    const lignes = certificat.apps.map(app => libelle(app));
                    const resultat = await pont.postMessage({
                        action: "replaceCertificate", token: plan.token, serial: certificat.serial,
                        certificate: certificat.label, impact: lignes.join("\n"),
                    });
                    if (resultat.error) throw new Error(resultat.error);
                    if (resultat.cancelled) return;
                    terminee = true;
                    const reprise = resultat.queued_repairs
                        ? ` Re-signing queued for ${resultat.queued_repairs} app(s).` : "";
                    const essai = resultat.retry_job ? " The original operation will retry." : "";
                    statut.textContent = (resultat.revoked
                        ? "The certificate was replaced."
                        : "A usable certificate is now available.") + reprise + essai;
                    statut.append(" ", lien("Open Activity", "/queue", "sr-app-activity-link"));
                } catch (erreur) {
                    terminee = true;
                    statut.textContent = globalThis.sideRelayJobs.messageErreur(lireErreur(erreur), lireErreur(erreur))
                        || "Could not confirm the result. Check Activity before trying again.";
                } finally {
                    enCours = false;
                    fermer.disabled = false;
                    if (terminee) fermer.textContent = "Close";
                    else selecteur.disabled = remplacer.disabled = false;
                }
            }, "btn btn-danger");
            remplacer.disabled = true;
            dialog.addEventListener("cancel", evenement => { if (enCours) evenement.preventDefault(); });
            const libelle = app => `${app.name} on ${app.device} (${app.certain ? "will stop opening" : "may stop opening"}${app.can_repair ? "" : ", IPA needed"})`;
            selecteur.addEventListener("change", () => {
                const certificat = plan.certificates.find(entree => entree.serial === selecteur.value);
                remplacer.disabled = !certificat;
                impact.replaceChildren();
                if (!certificat) return;
                if (certificat.apps.length) {
                    const liste = element("ul");
                    liste.append(...certificat.apps.map(app => element("li", libelle(app))));
                    impact.append(liste);
                } else impact.append(element("p", "No SideRelay app is linked to this certificate."));
                impact.append(element("p", avis, "muted"));
            });
            statut.textContent = "";
            contenu.append(etiquette, selecteur, impact);
            actions.append(remplacer);
        } catch (erreur) {
            fermer.textContent = "Close";
            statut.textContent = lireErreur(erreur) || "Could not read the certificates. Try again.";
        }
    }

    function tableauActivite(jobs, charger, feedback) {
        if (!jobs.length) return element("p", "No activity yet.", "muted");
        const table = element("table", "", "table sr-activity-table");
        table.setAttribute("aria-label", "Signing activity");
        const colonnes = table.createTHead().insertRow();
        for (const titre of ["App", "Device", "Status", "When"]) {
            colonnes.append(element("th", titre));
        }
        const corps = table.createTBody();
        const language = document.documentElement.lang || "en";
        const dateLocale = new Intl.DateTimeFormat(language, { month: "short", day: "numeric" });
        const timeLocale = new Intl.DateTimeFormat(language, { hour: "numeric", minute: "2-digit", hourCycle: "h23" });
        const fullDate = new Intl.DateTimeFormat(language, { dateStyle: "long", timeStyle: "short", hourCycle: "h23" });
        function dateActivite(job) {
            const secondes = job.finished_at ?? job.started_at;
            const cell = element("td", "", "sr-activity-date");
            if (!secondes) { cell.textContent = "—"; return cell; }
            const date = new Date(secondes * 1000);
            const time = element("time", dateLocale.format(date));
            time.dateTime = date.toISOString();
            time.title = [job.started_at && `Started ${fullDate.format(new Date(job.started_at * 1000))}`,
                job.finished_at && `Finished ${fullDate.format(new Date(job.finished_at * 1000))}`].filter(Boolean).join("\n");
            time.setAttribute("aria-label", time.title);
            time.append(element("span", timeLocale.format(date)));
            cell.append(time);
            return cell;
        }
        for (const job of jobs) {
            const ligne = corps.insertRow();
            ligne.dataset.jobId = job.id;
            const actionsLabel = { install: "Install", refresh: "Refresh", repair: "Re-sign" };
            const app = ligne.insertCell();
            app.append(element("strong", job.app_name), element("small", actionsLabel[job.kind] || job.kind, "muted sr-activity-kind"));
            const appareil = ligne.insertCell();
            appareil.append(lien(job.device_name, "/devices/" + encodeURIComponent(job.device_id), "sr-inline-link"));
            const statut = ligne.insertCell();
            const classe = ["done", "failed", "running"].includes(job.status) ? job.status : "queued";
            const labels = { done: "Completed", failed: "Failed", running: "In Progress", queued: "Queued", pending: "Pending", cancelled: "Cancelled", canceled: "Cancelled" };
            statut.append(element("span", labels[job.status] || job.status, `job-badge job-${classe}`));
            if (job.status === "running") {
                if (job.stage) statut.append(element("span", ` - ${job.stage}`, "job-stage"));
                const progression = element("div", "", "job-progress-bar-wrap");
                const barre = element("progress", "", "job-progress-bar");
                barre.max = 100;
                barre.value = job.progress;
                progression.append(barre, element("span", `${job.progress}%`, "job-progress-pct"));
                statut.append(progression);
            }
            if (job.error) {
                statut.append(element("p", job.error, "error"));
                const actions = element("div", "", "sr-activity-recovery");
                const style = "btn btn-sm btn-secondary";
                const account = encodeURIComponent(job.account_id || "");
                switch (globalThis.sideRelayJobs.typeErreur(job.error)) {
                    case "certificate-limit":
                        actions.append(bouton("Review Certificates…", () => examinerCertificats(job.id), style));
                        break;
                    case "app-id-limit":
                        if (account) actions.append(lien("Review App IDs", `/accounts?appIDs=${account}`, style));
                        break;
                    case "apple-account":
                        if (account) actions.append(lien("Reconnect Apple Account", `/accounts?reconnect=${account}`, style));
                        break;
                    case "pairing-unreachable":
                        if (!job.latest) break;
                        if (job.error.includes("Apple TV")) {
                            actions.append(lien("Open Device", "/devices/" + encodeURIComponent(job.device_id), style));
                            break;
                        }
                        if (!job.can_retry) {
                            actions.append(document.createTextNode("Drop the original IPA in Apps to retry."));
                            actions.append(lien("Open Apps", cheminApps, style));
                            break;
                        }
                        actions.append(bouton("Retry over USB", async control => {
                            control.disabled = true;
                            feedback.textContent = "Checking the USB connection…";
                            try {
                                await globalThis.sideRelayJobs.requete("retry_failed_usb", { job_id: job.id });
                                feedback.textContent = "USB retry queued.";
                                await charger();
                            } catch (error) {
                                feedback.textContent = globalThis.sideRelayJobs.typeErreur(error.message) === "pairing-unreachable"
                                    ? "Connect this iPhone by USB, unlock it and tap Trust if asked. Then retry."
                                    : "Could not retry this job. Check that the IPA is still saved and no other operation is running.";
                            } finally { control.disabled = false; }
                        }, style));
                        break;
                    case "apple-connection":
                        actions.append(lien("Open Apple Accounts", "/accounts", style));
                        break;
                    case "install-limit":
                    case "main-profile-verification":
                        actions.append(lien("Open Apps", cheminApps, style));
                        break;
                }
                if (actions.childNodes.length) statut.append(actions);
            }
            ligne.append(dateActivite(job));
        }
        expliquerEchecs(table);
        return table;
    }

    function afficherActivite(main) {
        const panneau = element("section", "", "sr-activity");
        const entete = element("div", "", "page-header");
        const statut = element("p", "", "sr-activity-status");
        statut.setAttribute("role", "status");
        const contenu = element("div", "", "sr-activity-content");
        contenu.append(element("p", "Loading activity…", "muted"));
        let minuterie, dernierResultat, lecture = false;
        let effacable = false;
        let effacement = false;
        globalThis.sideRelayRefreshActivity = () => {
            if (!document.querySelector("dialog[open]")) void charger();
        };
        async function effacer() {
            if (!window.confirm("Clear completed activity? Installation logs will still be available.")) return;
            clearTimeout(minuterie);
            effacement = true;
            try {
                await pont.postMessage({ action: "clearActivity" });
                effacable = false;
                statut.textContent = "Completed activity cleared.";
            } catch { statut.textContent = "Could not clear activity. Try again."; }
            finally { effacement = false; }
            await charger();
        }

        async function charger() {
            if (!panneau.isConnected || lecture || effacement) return;
            lecture = true;
            clearTimeout(minuterie);
            try {
                const { jobs, canClear } = await pont.postMessage({ action: "activity" });
                if (!panneau.isConnected) return;
                const resultat = JSON.stringify(jobs);
                if (resultat !== dernierResultat) {
                    const oldRows = [...contenu.querySelectorAll("tr[data-job-id]")];
                    const expanded = new Set(oldRows.filter(row => row.querySelector("details[open]")).map(row => row.dataset.jobId));
                    const focused = document.activeElement;
                    const focusID = focused?.closest("tr[data-job-id]")?.dataset.jobId;
                    const focusLabel = focused?.textContent;
                    contenu.replaceChildren(tableauActivite(jobs, charger, statut));
                    for (const row of contenu.querySelectorAll("tr[data-job-id]")) {
                        const details = row.querySelector("details");
                        if (details && expanded.has(row.dataset.jobId)) details.open = true;
                        if (row.dataset.jobId === focusID) {
                            [...row.querySelectorAll("button,a,summary")].find(control => control.textContent === focusLabel)?.focus({preventScroll: true});
                        }
                    }
                    dernierResultat = resultat;
                }
                effacable = canClear;
                if (statut.textContent === "Could not refresh activity.") statut.textContent = "";
                if (jobs.some(job => ["running", "queued", "pending"].includes(job.status))) {
                    minuterie = setTimeout(charger, 3000);
                }
            } catch {
                if (dernierResultat === undefined) contenu.replaceChildren(element("p", "Could not load activity.", "muted"));
                else if (!statut.textContent) statut.textContent = "Could not refresh activity.";
            } finally {
                lecture = false;
            }
        }

        const more = bouton("More", async button => {
            if (button.dataset.menuOpen) return;
            button.dataset.menuOpen = "1";
            const rect = button.getBoundingClientRect();
            try {
                const action = await pont.postMessage({
                    action: "activityActions", x: String(rect.left), y: String(rect.bottom), clear: effacable && !lecture && !effacement ? "1" : "0",
                });
                if (!panneau.isConnected) return;
                if (action === "logs") await pont.postMessage({ action: "installLogs" });
                if (action === "clear" && effacable && !lecture && !effacement) await effacer();
            } catch { statut.textContent = "Could not open the action. Try again."; }
            finally { delete button.dataset.menuOpen; }
        }, "btn btn-secondary sr-toolbar-menu");
        more.setAttribute("aria-label", "More activity actions");
        more.setAttribute("aria-haspopup", "menu");
        const actions = element("div", "", "sr-actions");
        actions.append(more);
        entete.append(element("h1", "Activity"), actions);
        panneau.append(entete, statut, contenu);
        main.prepend(panneau);
        void charger();
    }

    function expliquerEchecs(main) {
        for (const erreur of main.querySelectorAll(".job-failed ~ .error")) {
            if (erreur.classList.contains("sr-job-error-raw")) continue;
            const texte = erreur.textContent.trim();
            const message = globalThis.sideRelayJobs.messageErreur(texte, "The operation failed. Open Technical Details for the reason.");
            const resume = element("p", message, "sr-job-error-summary");
            const details = element("details", "", "sr-job-error-details");
            details.append(element("summary", "Technical details"), element("pre", texte));
            erreur.classList.add("sr-job-error-raw");
            erreur.after(resume, details);
        }
    }

    function actualiser() {
        const racine = document.documentElement;
        const main = document.querySelector("main.main-content");
        if (!main) return;
        const chemin = location.pathname;
        const actif = racine.dataset.srView === "app";
        const sectionApps = actif && chemin === "/" && location.search === "?view=apps";
        racine.toggleAttribute("data-sr-apps", sectionApps);
        const sectionStore = actif && chemin === "/" && location.search === "?view=store";
        racine.toggleAttribute("data-sr-store", sectionStore);
        const route = location.pathname + location.search;
        if (actif && seenRoute !== route) {
            seenRoute = route;
            void pont.postMessage({ action: "windowNavigation" }).catch(() => { seenRoute = undefined; });
        } else if (!actif) seenRoute = undefined;
        main.classList.toggle("sr-device-detail", chemin.startsWith("/devices/"));
        if (!chemin.startsWith("/devices/")) {
            deviceDetails = undefined;
            main.removeAttribute("data-sr-tv-device");
        }
        const panneauStore = main.querySelector(":scope > .sr-store");
        if (sectionStore) {
            if (!panneauStore) globalThis.sideRelayCatalogue.mountStore(main);
        } else { panneauStore?.remove(); }
        const panneauApps = main.querySelector(":scope > .sr-app-catalog");
        if (sectionApps) {
            if (!panneauApps) catalogue(main);
        } else { panneauApps?.remove(); }

        if (actif && chemin === "/accounts") {
            globalThis.sideRelayCatalogue.accountCertificates(main);
        } else {
            main.querySelector(".sr-account-certificates")?.remove();
        }

        const panneauActivite = main.querySelector(":scope > .sr-activity");
        if (actif && chemin === "/queue") {
            if (!panneauActivite) afficherActivite(main);
        } else { panneauActivite?.remove(); }

        if (chemin === "/devices" && (actif || racine.dataset.srView === "setup-0")) {
            ajouterIPhone(main);
            if (actif) deviceList(main);
        }

        const titre = main.querySelector(".page > .page-header");
        if (actif && titre && !commandes.has(titre)) {
            if (chemin === "/") titre.querySelector("h1").textContent = "Overview";
            commandes.add(titre);
        }
        if (actif && chemin === "/" && !sectionApps && !sectionStore) {
            for (const gererApps of main.querySelectorAll('.device-card-footer > a[href^="/devices/"]')) {
                const carte = gererApps.closest(".device-card");
                const nom = carte?.querySelector(".device-card-header > .device-name");
                if (nom && !nom.parentElement.querySelector(".sr-overview-device-link")) {
                    const fiche = lien("", gererApps.getAttribute("href"), "sr-overview-device-link");
                    fiche.setAttribute("aria-label", `Manage ${nom.textContent.trim()}`);
                    carte.classList.add("sr-overview-device-card");
                    nom.after(fiche);
                }
                gererApps.setAttribute("href", cheminApps);
            }
            const grid = main.querySelector(".device-grid");
            presenterAppareils(grid, [...main.querySelectorAll(".sr-overview-device-link")]);
            overviewRefreshState(grid);
            const vide = main.querySelector(".page > .empty-state");
            if (vide && !commandes.has(vide)) {
                const titreVide = element("h2", "Add your first device");
                vide.replaceChildren(titreVide, element("p", "Find your iPhone on USB, Wi-Fi or Tailscale."),
                    lien("Add a Device", "/devices", "btn btn-primary"));
                commandes.add(vide);
            }
        } else if (overviewRefresh) {
            clearTimeout(overviewRefresh.timer);
            for (const panel of overviewRefresh.grid.querySelectorAll(".sr-overview-refresh:popover-open")) panel.hidePopover();
            overviewRefresh = undefined;
        }
        if (actif && /^\/devices\/[^/]+/.test(chemin)) devicePage(main, chemin);
    }

    const dom = new MutationObserver(actualiser);
    dom.observe(document.body, {childList: true, characterData: true, subtree: true});
    dom.observe(document.documentElement, {
        attributes: true, attributeFilter: ["data-sr-view"],
    });
    window.addEventListener("popstate", actualiser);
    if (window.navigation) window.navigation.addEventListener("currententrychange", actualiser);
    actualiser();
})();
