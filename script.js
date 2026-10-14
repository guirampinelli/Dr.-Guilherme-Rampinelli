(function () {
  "use strict";

  var attributionKey = "drguilherme_attribution_v3";
  var trackedKeys = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
    "utm_id",
    "fbclid"
  ];
  var doctoraliaSelector = 'a[data-doctoralia-link="true"]';
  var currentParams = new URLSearchParams(window.location.search);
  var pageType = document.body.dataset.pageType || "teleconsulta_landing";
  var pageVariant = document.body.dataset.pageVariant || "premium_identity_doctoralia_v1";
  // Medição interna: somente a landing de consulta, nunca páginas de artigos.
  var metricsPage = document.body.dataset.metricsPage === "consulta_online" ? "consulta_online" : "";
  var measurementSessionKey = "drg_measurement_session_v1";
  var scheduleCtas = ["service_header", "service_hero", "service_final", "service_sticky"];
  // Allowlist fechada (igual à do servidor): outros valores de utm_campaign não são enviados.
  var campaignCodesAllowed = ["drg_ig_lpv_202610", "drg_ig_contact_202610", "drg_contact_sp_rj_202608", "drg_teleconsulta_sp_rj_2026_08"];
  var metaIdPattern = /^\d{15,20}$/;
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  var memorySessionId = "";
  // Visita já enviada nesta página, no formato "<uuid da sessão>|<dia de São Paulo>".
  var reportedVisitKey = "";

  document.documentElement.classList.add("reveal-ready");

  function sanitize(value, maxLength) {
    return String(value || "")
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .trim()
      .slice(0, maxLength || 240);
  }

  function readStoredAttribution() {
    try {
      var parsed = JSON.parse(window.localStorage.getItem(attributionKey) || "{}");
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch (error) {
      return {};
    }
  }

  function currentTouch() {
    var touch = {};
    trackedKeys.forEach(function (key) {
      var value = sanitize(currentParams.get(key), key === "fbclid" ? 500 : 240);
      if (value) touch[key] = value;
    });
    if (!Object.keys(touch).length) return null;
    touch.captured_at = new Date().toISOString();
    return touch;
  }

  var storedAttribution = readStoredAttribution();
  var visitTouch = currentTouch();
  var attribution = {
    first_touch: storedAttribution.first_touch || visitTouch || null,
    last_touch: visitTouch || storedAttribution.last_touch || null
  };

  function persistAttribution() {
    if (window.__drMeasurementConsent !== "granted") return;
    try {
      window.localStorage.setItem(attributionKey, JSON.stringify(attribution));
    } catch (error) {
      // A atribuição segue disponível apenas durante esta visita.
    }
  }

  function clearAttribution() {
    try {
      window.localStorage.removeItem(attributionKey);
    } catch (error) {
      // Nenhuma ação adicional é necessária.
    }
  }

  function makeEventId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "drg_" + window.crypto.randomUUID();
    }
    return "drg_" + Date.now() + "_" + Math.random().toString(36).slice(2, 14);
  }

  function getLandingPath() {
    if (window.location.protocol === "file:") return "/";
    return window.location.pathname || "/";
  }

  function reportDoctoraliaContact(link) {
    if (window.__drMeasurementConsent !== "granted") return;
    // "Ver perfil" não é intenção de agendar: não gera Contact.
    if (link.dataset.ctaKind === "profile") return;

    var payload = {
      event_type: "doctoralia_schedule_click",
      event_id: makeEventId(),
      event_time: new Date().toISOString(),
      page_path: getLandingPath(),
      page_type: sanitize(pageType, 80),
      page_variant: sanitize(pageVariant, 100),
      cta_location: sanitize(link.dataset.ctaLocation || "unknown", 80),
      destination_url: link.href,
      attribution: attribution
    };

    try {
      window.fetch("/api/public/site-events/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
        keepalive: true
      }).catch(function () {
        // A medição nunca impede a navegação para a Doctoralia.
      });
    } catch (error) {
      // A medição nunca impede a navegação para a Doctoralia.
    }
  }

  function randomUuid() {
    var cryptoApi = window.crypto;
    if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
    if (!cryptoApi || typeof cryptoApi.getRandomValues !== "function") return "";
    var bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = Array.prototype.map
      .call(bytes, function (byte) {
        return (byte + 0x100).toString(16).slice(1);
      })
      .join("");
    return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join("-");
  }

  // Identificador opaco da sessão, criado só após consentimento e guardado
  // apenas no sessionStorage (some ao fechar a aba).
  function measurementSessionId() {
    if (window.__drMeasurementConsent !== "granted") return "";
    var stored = "";
    try {
      stored = window.sessionStorage.getItem(measurementSessionKey) || memorySessionId;
    } catch (error) {
      stored = memorySessionId;
    }
    if (uuidPattern.test(stored)) return stored;

    var created = randomUuid();
    if (!uuidPattern.test(created)) return "";
    memorySessionId = created;
    try {
      window.sessionStorage.setItem(measurementSessionKey, created);
    } catch (error) {
      // Sem sessionStorage, o identificador vale apenas para esta página.
    }
    return created;
  }

  function clearMeasurementSession() {
    memorySessionId = "";
    // Nova sessão (ex.: aceitar → recusar → aceitar) precisa de nova visita.
    reportedVisitKey = "";
    try {
      window.sessionStorage.removeItem(measurementSessionKey);
    } catch (error) {
      // Nenhuma ação adicional é necessária.
    }
  }

  // Dia civil de São Paulo (UTC−3, sem horário de verão desde 2019), igual ao servidor.
  function saoPauloDay() {
    return new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }

  // Apenas códigos conhecidos de campanha; texto livre nunca é enviado.
  // Parametrização dos anúncios: utm_id={{campaign.id}}, utm_term={{adset.id}},
  // utm_content={{ad.id}}; campaign_id/adset_id/ad_id explícitos também valem.
  function campaignCodes() {
    var lastTouch = attribution.last_touch || {};
    function param(key) {
      return sanitize(currentParams.get(key) || lastTouch[key] || "", 64);
    }
    function metaId(keys) {
      for (var index = 0; index < keys.length; index += 1) {
        var value = sanitize(param(keys[index]), 32);
        if (metaIdPattern.test(value)) return value;
      }
      return "";
    }
    var codes = {};
    var source = param("utm_source").toLowerCase();
    var medium = param("utm_medium").toLowerCase();
    var campaign = param("utm_campaign");
    if (["meta", "facebook", "instagram"].indexOf(source) !== -1) codes.utm_source = source;
    if (medium === "paid_social") codes.utm_medium = medium;
    if (campaignCodesAllowed.indexOf(campaign) !== -1) codes.utm_campaign = campaign;
    var campaignId = metaId(["campaign_id", "utm_id"]);
    var adsetId = metaId(["adset_id", "utm_term"]);
    var adId = metaId(["ad_id", "utm_content"]);
    if (campaignId) codes.campaign_id = campaignId;
    if (adsetId) codes.adset_id = adsetId;
    if (adId) codes.ad_id = adId;
    return codes;
  }

  function sendMetric(path, payload) {
    try {
      window.fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        credentials: "same-origin",
        keepalive: true
      }).catch(function () {
        // A medição nunca interfere na navegação.
      });
    } catch (error) {
      // A medição nunca interfere na navegação.
    }
  }

  // Garante uma visita para esta sessão no dia atual de São Paulo. Retorna o UUID
  // da sessão (ou "" sem consentimento). Se a aba atravessou a meia-noite, envia
  // uma visita do novo dia antes do clique.
  function ensureLandingVisit() {
    if (!metricsPage) return "";
    var sessionId = measurementSessionId();
    if (!sessionId) return "";
    var visitKey = sessionId + "|" + saoPauloDay();
    if (reportedVisitKey === visitKey) return sessionId;
    reportedVisitKey = visitKey;
    sendMetric("/api/public/site-metrics/visit", {
      type: "landing_visit",
      event_id: makeEventId(),
      session_id: sessionId,
      page: metricsPage,
      attribution: campaignCodes()
    });
    return sessionId;
  }

  // Só botões de agendamento da landing contam; links de perfil ficam de fora.
  function reportScheduleClick(link) {
    if (!metricsPage || link.dataset.ctaKind === "profile") return;
    var cta = link.dataset.ctaLocation || "";
    if (scheduleCtas.indexOf(cta) === -1) return;
    var sessionId = ensureLandingVisit();
    if (!sessionId) return;
    sendMetric("/api/public/site-metrics/schedule-click", {
      type: "schedule_click",
      event_id: makeEventId(),
      session_id: sessionId,
      page: metricsPage,
      cta: cta,
      attribution: campaignCodes()
    });
  }

  persistAttribution();
  if (window.__drMeasurementConsent === "granted") ensureLandingVisit();
  else clearMeasurementSession();

  document.addEventListener("drg:measurement-consent-change", function () {
    if (window.__drMeasurementConsent === "granted") {
      // O aceite pode ter vindo de outra aba, que já gravou a atribuição dela.
      var latest = readStoredAttribution();
      attribution = {
        first_touch: latest.first_touch || attribution.first_touch || null,
        last_touch: visitTouch || latest.last_touch || attribution.last_touch || null
      };
      persistAttribution();
      ensureLandingVisit();
    } else {
      clearAttribution();
      clearMeasurementSession();
      // Mantém só a origem desta página; a atribuição anterior foi revogada.
      attribution = { first_touch: visitTouch, last_touch: visitTouch };
    }
  });

  document.addEventListener("click", function (event) {
    var link = event.target && event.target.closest ? event.target.closest(doctoraliaSelector) : null;
    if (!link) return;
    reportDoctoraliaContact(link);
    reportScheduleClick(link);
  });

  var revealItems = Array.prototype.slice.call(document.querySelectorAll("[data-reveal]"));
  if (!("IntersectionObserver" in window)) {
    revealItems.forEach(function (item) {
      item.classList.add("is-visible");
    });
  } else {
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-visible");
          observer.unobserve(entry.target);
        });
      },
      { threshold: 0.16 }
    );

    revealItems.forEach(function (item) {
      observer.observe(item);
    });
  }

  var hero = document.querySelector(".hero, [data-sticky-cta-anchor]");
  if (hero && "IntersectionObserver" in window) {
    var stickyObserver = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          document.documentElement.classList.toggle("show-mobile-cta", !entry.isIntersecting);
        });
      },
      { threshold: 0.08 }
    );
    stickyObserver.observe(hero);
  }
})();
