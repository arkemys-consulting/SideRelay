(() => {
    if (location.origin !== "http://127.0.0.1:18784") return;
    const pont = window.webkit.messageHandlers.signatureCompte;
    const demande = (action, valeurs = {}) => pont.postMessage({ action, ...valeurs });
    const progression = {
        starting: ["Starting pairing…", ""],
        usbConnect: ["Connecting by USB…", "Keep the iPhone unlocked. Tap Trust if the iPhone asks."],
        usbApprove: ["Waiting for your iPhone…", "Tap Trust on the iPhone and enter its passcode if asked."],
        usbConfirm: ["Confirming pairing…", "Keep the iPhone unlocked and connected."],
        wifiWait: ["Waiting for your iPhone…", "On the iPhone, open Settings → Privacy & Security → Developer Mode and select SideRelay. Both devices must be on the same network."],
        wifiConnected: ["iPhone connected", "Getting the pairing code…"],
        wifiCode: ["Enter this code on your iPhone", "Use the code in the pairing prompt on your iPhone."],
        verifying: ["Verifying the connection…", "Keep the iPhone unlocked until SideRelay confirms it was added."],
    };
    const erreurs = {
        usbDisconnected: ["iPhone disconnected", "Reconnect the USB cable, unlock the iPhone, then try again."],
        usbUnavailable: ["Could not connect over USB", "Reconnect the cable. Keep the iPhone unlocked and tap Trust if prompted."],
        usbTrust: ["This Mac couldn’t use USB pairing", "Unlock the iPhone, open it in Finder and tap Trust if prompted. Then try again."],
        usbUnsupported: ["Remote pairing is unavailable over USB", "This requires iOS 17.4 or later. On your iPhone, go to Settings → Privacy & Security → Developer Mode, turn it on, then restart and confirm."],
        usbApprovalFailed: ["The iPhone didn’t confirm pairing", "Keep the screen unlocked and accept the Trust prompt if it appears."],
        wifiUnavailable: ["Could not start Wi-Fi pairing", "Check that SideRelay has Local Network access in System Settings and that both devices are on the same network."],
        wifiNoNetwork: ["This Mac has no local network connection", "Connect it to the same network as the iPhone, then try again."],
        wifiApprovalFailed: ["The code was not confirmed", "Start again, select SideRelay on your iPhone and enter the new code."],
        timedOut: ["Pairing timed out", "Unlock the iPhone and try again. For Wi-Fi, select SideRelay under Developer Mode when it appears."],
        invalidSelection: ["Choose a valid iPhone address", "Select an available connection or enter its IPv4 address."],
        verifyFailed: ["Paired. Connection check failed.", "Keep the iPhone unlocked. Check the selected connection and retry here. You don’t need a new pairing code."],
        unreachable: ["Paired. The iPhone isn’t reachable.", "Check that Tailscale is connected on the iPhone, or choose its local network address if both devices are on the same network."],
        recordRejected: ["The selected iPhone didn’t accept this pairing", "Select the address of the iPhone you just paired, then retry the connection."],
        tunnelFailed: ["Paired. Couldn’t open the installation connection.", "Keep the iPhone unlocked and connected to the selected network, then retry."],
        addressRequired: ["Paired. Choose an address to finish.", "Select the iPhone’s Tailscale or local network address, then retry the connection."],
        startFailed: ["SideRelay couldn’t complete pairing", "Try again. If this keeps happening, quit and reopen SideRelay."],
    };

    function node(tag, text, className) {
        const e = document.createElement(tag);
        if (text) e.textContent = text;
        if (className) e.className = className;
        return e;
    }

    function button(text, action, primary = false) {
        const b = node("button", text, `btn ${primary ? "btn-primary" : "btn-secondary"}`);
        b.type = "button";
        b.addEventListener("click", event => { if (event.isTrusted) void action(); });
        return b;
    }

    function option(text, value) {
        const o = node("option", text);
        o.value = value;
        return o;
    }

    async function ouvrir({ mode, appareil, adresses, adresse, connexion }) {
        if (document.querySelector(".sr-pair-dialog[open]")) return;
        const boite = node("dialog", "", "sr-pair-dialog");
        const nom = appareil?.name;
        const titre = node("h2", nom ? `Pair ${nom}` : "Pair an iPhone");
        titre.id = "sr-pair-title";
        boite.setAttribute("aria-labelledby", titre.id);
        const intro = node("p", mode === "usb"
            ? "Keep the iPhone plugged in and unlocked. Tap Trust if it asks."
            : "Wi-Fi pairing requires iOS 27 or later. Keep the iPhone unlocked and on the same network as this Mac.", "sr-pair-intro");
        const section = node("div", "", "sr-pair-connection");
        const label = node("label", "Connection after pairing", "form-field");
        const choix = node("select");
        choix.required = true;
        choix.append(option("Select your iPhone…", ""));
        const texte = node("p", "", "sr-pair-hint");
        const champ = node("input");
        champ.type = "text";
        champ.inputMode = "decimal";
        champ.placeholder = "iPhone’s IPv4 address";
        champ.setAttribute("aria-label", "iPhone’s IPv4 address");
        champ.autocomplete = "off";
        const manuel = "manual";
        const local = "wifi-source";
        const config = new Map(adresses.map(e => [e.address, e]));
        const ordre = connexion === "tailscale" ? ["tailscale", "wifi"] : ["wifi", "tailscale"];
        for (const source of ordre) {
            const texteMode = source === "tailscale" ? "Tailscale" : "Local network";
            for (const a of config.values()) {
                if (a.source === source) choix.append(option(`${texteMode} · ${a.name} · ${a.address}`, a.address));
            }
            if (source === "wifi" && mode === "wifi") choix.append(option("Local network · use the address from pairing", local));
        }
        choix.append(option("Enter an IP address manually…", manuel));
        const preferees = adresses.filter(a => a.source === ordre[0]);
        if (adresse && config.has(adresse)) choix.value = adresse;
        else if (mode === "usb" && new Set(adresses.map(a => a.name?.replace(/[^a-z0-9]/gi, "").toLowerCase())).size > 1) choix.value = "";
        else if (preferees.length === 1) choix.value = preferees[0].address;
        else if (adresses.length === 1) choix.value = adresses[0].address;
        else if (mode === "wifi" && !adresses.length) choix.value = local;
        label.append(choix);
        section.append(label, champ, texte);
        const simplified = document.createElement("input");
        simplified.type = "checkbox";
        if (mode === "usb") {
            const option = node("label", "", "sr-app-ipa-refresh");
            option.append(simplified, "Try simplified USB pairing (Beta)");
            section.append(option);
        }
        function expliquer() {
            champ.hidden = choix.value !== manuel;
            const source = config.get(choix.value)?.source;
            texte.textContent = source === "tailscale"
                ? "For installs away from home. Keep Tailscale connected on your iPhone."
                : source === "wifi" || choix.value === local
                    ? "For installs on this local network."
                    : choix.value === manuel ? "Enter the iPhone’s IPv4 address."
                    : connexion === "tailscale" && !preferees.length
                        ? "No Tailscale address found. Connect Tailscale on the iPhone, or select a local connection."
                        : mode === "usb" && !adresses.length
                            ? "Keep the iPhone on the same local network as the Mac or connect Tailscale. Scan again to find its address."
                            : "Choose the connection for the iPhone you’re pairing.";
        }
        choix.addEventListener("change", expliquer);
        expliquer();

        const resultat = node("div", "", "sr-pair-result");
        resultat.setAttribute("role", "status");
        resultat.tabIndex = -1;
        const etat = node("h3");
        const message = node("p");
        const pin = node("output", "", "sr-pair-code");
        pin.setAttribute("aria-label", "Pairing code");
        resultat.append(etat, pin, message);
        resultat.hidden = true;
        pin.hidden = true;
        let minuterie;
        let fermeture = false;
        let dernierEtat = "";
        const actions = node("div", "", "sr-pair-actions");
        const quitter = button("Cancel", fermer);
        const commencer = button(mode === "usb" ? "Pair via USB" : "Start Wi-Fi Pairing", () => lancer(false), true);
        const reprendre = button("Try Again", () => lancer(false), true);
        const verifier = button("Retry Connection", () => lancer(true), true);
        const terminer = button("Done", async () => {
            await fermer();
            location.reload();
        }, true);
        reprendre.hidden = verifier.hidden = terminer.hidden = true;
        actions.append(quitter, commencer, reprendre, verifier, terminer);
        boite.append(titre, intro, section, resultat, actions);
        document.body.append(boite);
        boite.addEventListener("cancel", event => {
            event.preventDefault();
            if (!quitter.hidden && !quitter.disabled) void fermer();
        });
        boite.showModal();

        async function fermer() {
            if (fermeture) return;
            fermeture = true;
            clearTimeout(minuterie);
            quitter.disabled = true;
            try { await demande("closePairing"); }
            catch { /* The helper stops if the app closes, and has its own timeout. */ }
            boite.close();
            boite.remove();
        }

        function afficher(donnees) {
            if (fermeture || !boite.isConnected) return;
            const stage = donnees?.stage;
            if (stage === dernierEtat) return;
            dernierEtat = stage;
            const enCours = Object.hasOwn(progression, stage);
            const succes = stage === "added" || stage === "alreadyAdded";
            const avecCle = ["verifyFailed", "addressRequired", "unreachable", "recordRejected", "tunnelFailed"].includes(stage);
            const messages = succes
                ? [stage === "added" ? "iPhone added" : "iPhone already added", "You’ll find it under My Devices."]
                : progression[stage] || erreurs[stage] || erreurs.startFailed;
            resultat.hidden = false;
            resultat.dataset.state = enCours ? "working" : succes ? "success" : "error";
            etat.textContent = messages[0];
            message.textContent = messages[1];
            pin.hidden = stage !== "wifiCode";
            pin.textContent = stage === "wifiCode" ? donnees.code : "";
            section.hidden = enCours || succes;
            intro.hidden = enCours || succes;
            quitter.hidden = succes || stage === "verifying";
            quitter.textContent = enCours ? "Cancel" : "Close";
            commencer.hidden = true;
            reprendre.hidden = enCours || succes || avecCle;
            verifier.hidden = !avecCle;
            terminer.hidden = !succes;
            if (succes) terminer.focus();
            else if (!enCours) (avecCle ? verifier : reprendre).focus();
            else if (stage === "verifying") resultat.focus();
        }

        async function suivre() {
            try {
                const etat = await demande("pairingStatus");
                if (fermeture) return;
                afficher(etat);
                if (Object.hasOwn(progression, etat.stage)) minuterie = setTimeout(suivre, 450);
            } catch { afficher({ stage: "startFailed" }); }
        }

        async function lancer(reessai) {
            if (!choix.reportValidity()) return;
            const address = choix.value === local ? "" : choix.value === manuel ? champ.value.trim() : choix.value;
            if (choix.value === manuel && !address) {
                champ.setCustomValidity("Enter the iPhone’s IPv4 address.");
                champ.reportValidity();
                champ.setCustomValidity("");
                champ.focus();
                return;
            }
            commencer.disabled = reprendre.disabled = verifier.disabled = true;
            afficher({ stage: reessai ? "verifying" : "starting" });
            try {
                const etat = await demande(reessai ? "retryPairing" : "startPairing", {
                    address, mode, device: appareil?.id || "", simplifiedUSB: simplified.checked ? "1" : "0",
                });
                if (fermeture) return;
                afficher(etat);
                if (Object.hasOwn(progression, etat.stage)) minuterie = setTimeout(suivre, 350);
            } catch { afficher({ stage: "startFailed" }); }
            finally { commencer.disabled = reprendre.disabled = verifier.disabled = false; }
        }
    }

    globalThis.sideRelayPair = ouvrir;
})();
