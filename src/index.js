import h5wasm from "h5wasm";
import * as GeoTIFF from "geotiff";


const RADAR_POINTS = [
  {
    nom: "Lannemezan",
    bassin: "Baïse",
    position: "Amont",
    latitude: 43.1250,
    longitude: 0.3840
  },
  {
    nom: "Trie-sur-Baïse",
    bassin: "Baïse",
    position: "Amont",
    latitude: 43.3207,
    longitude: 0.3704
  },
  {
    nom: "Mirande",
    bassin: "Baïse",
    position: "Médian",
    latitude: 43.5142,
    longitude: 0.4015
  },
  {
    nom: "Beaucaire",
    bassin: "Baïse",
    position: "Aval",
    latitude: 43.8378,
    longitude: 0.3851
  }
];

const FORECAST_POINTS =
  RADAR_POINTS.map(
    ({ ligne, colonne, ...point }) => point
  );


// ==================================================
// WORKER
// ==================================================
export default {

async scheduled(event, env, ctx) {

  // --------------------------------------------------
  // RADAR : toutes les 10 minutes
  // --------------------------------------------------

  if (event.cron === "*/10 * * * *") {

    console.log("CRON RADAR");

    ctx.waitUntil(
      collecteRadar(env).catch(error => {

        console.error(
          "Erreur Cron Radar :",
          error.message
        );

      })
    );

    return;
  }


  // --------------------------------------------------
  // COLLECTE GENERALE : toutes les heures
  // --------------------------------------------------

  if (event.cron === "0 * * * *") {

    console.log("CRON COLLECTE");

    ctx.waitUntil(
      collecteEtStockage(env).catch(error => {

        console.error(
          "Erreur Cron :",
          error.message
        );

      })
    );

  }

},

async fetch(request, env) {

  const url =
    new URL(request.url);

  const periode =
    url.searchParams.get(
      "periode"
    ) || "tout";

  try {

    return new Response(
      await afficherPage(
        env,
        periode
      ),
      {
        headers: {
          "content-type":
            "text/html; charset=UTF-8"
        }
      }
    );

  } catch (error) {

    return new Response(
      `Erreur Worker : ${error.message}`,
      {
        status: 500,
        headers: {
          "content-type":
            "text/plain; charset=UTF-8"
        }
      }
    );

  }

}

};


// ==================================================
// RADAR METEO-FRANCE
// ==================================================

async function collecteRadar(env) {

  const url =
    "https://public-api.meteofrance.fr/public/DPRadar/v1/" +
    "mosaiques/METROPOLE/observations/LAME_D_EAU/produit?maille=500";

  console.log(
    "RADAR API KEY PRESENT",
    !!env.METEOFRANCE_AROME_API_KEY
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          apikey:
            env.METEOFRANCE_AROME_API_KEY
        }
      }
    );

  console.log(
    "RADAR HTTP",
    response.status
  );

  if (!response.ok) {

    throw new Error(
      `Meteo-France ${response.status}: ` +
      await response.text()
    );

  }

  const disposition =
    response.headers.get(
      "content-disposition"
    ) || "";

  const match =
    disposition.match(
      /(\d{14})/
    );

  if (!match) {

    throw new Error(
      "Horodatage du produit radar introuvable"
    );

  }

  const s = match[1];

  const timestamp =
    `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T` +
    `${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z`;

  const buffer =
    await response.arrayBuffer();

  const Module =
    await h5wasm.ready;

  const { FS } =
    Module;

  FS.writeFile(
    "/radar.h5",
    new Uint8Array(buffer)
  );

  const file =
    new h5wasm.File(
      "/radar.h5",
      "r"
    );

  const dataset =
    file.get(
      "dataset1/data1/data"
    );

  const data =
    dataset.value;

  const cols =
    dataset.shape[1];

  const pluies =
    RADAR_POINTS.map(
      point => {

        const valeurBrute =
          data[
            point.ligne * cols +
            point.colonne
          ];

        if (
          valeurBrute === 65535 ||
          valeurBrute === 65534
        ) {

          return 0;

        }

        return valeurBrute * 0.01*2;

      }
    );

  let historique =
    await env.RADAR.get(
      "radar_history",
      "json"
    );

  if (!Array.isArray(historique)) {
    historique = [];
  }

  if (
    !historique.some(
      m => m.t === timestamp
    )
  ) {

    historique.push({
      t: timestamp,
      p: pluies
    });

  }

  const limite =
    new Date(timestamp).getTime() -
    15 * 24 * 60 * 60 * 1000;

  historique =
    historique
      .filter(
        m =>
          new Date(
            m.t
          ).getTime() >= limite
      )
      .sort(
        (a, b) =>
          new Date(a.t).getTime() -
          new Date(b.t).getTime()
      )
      .slice(-4320);

  await env.RADAR.put(
    "radar_history",
    JSON.stringify(
      historique
    )
  );

  console.log(
    "Radar OK",
    timestamp,
    `${historique.length} mesures`
  );

}


// ==================================================
// CUMULS RADAR
// ==================================================

function calculerCumuls(
  historique,
  index,
  maintenant
) {

  const periodes = {

    "12 h":
      12 * 60 * 60 * 1000,

    "24 h":
      24 * 60 * 60 * 1000,

    "2 j":
      2 * 24 * 60 * 60 * 1000,

    "6 j":
      6 * 24 * 60 * 60 * 1000,

    "15 j":
      15 * 24 * 60 * 60 * 1000

  };

  const result = {};

  for (
    const [nom, duree]
    of Object.entries(periodes)
  ) {

    const limite =
      maintenant - duree;

    let somme = 0;

    for (
      const mesure
      of historique
    ) {

      const t =
        new Date(
          mesure.t
        ).getTime();

      if (
        t > limite &&
        t <= maintenant
      ) {

        somme +=
          Number(
            mesure.p[index] || 0
          );

      }

    }

    result[nom] =
      Math.round(
        somme * 100
      ) / 100;

  }

  return result;

}


// ==================================================
// AROME
// ==================================================

async function collectePrevisionsAROME(env) {

  const BASE =
    "https://public-api.meteofrance.fr/public/arome/1.0/wcs/" +
    "MF-NWP-HIGHRES-AROME-001-FRANCE-WCS";


  // --------------------------------------------------
  // 1. CATALOGUE
  // --------------------------------------------------

  const capResponse =
    await fetch(
      BASE +
      "/GetCapabilities" +
      "?service=WCS&version=2.0.1&language=fre",
      {
        headers: {
          apikey:
            env.METEOFRANCE_AROME_API_KEY
        }
      }
    );

  console.log(
    "AROME GetCapabilities",
    capResponse.status
  );

  const catalogue =
    await capResponse.text();

  if (!capResponse.ok) {

    throw new Error(
      `AROME GetCapabilities ${capResponse.status}: ${catalogue}`
    );

  }


  // --------------------------------------------------
  // 2. COVERAGES P2D
  // --------------------------------------------------

  const regex =
    /<wcs:CoverageId>(TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)_P2D)<\/wcs:CoverageId>/g;

  const couvertures = [];

  for (
    const match
    of catalogue.matchAll(regex)
  ) {

    couvertures.push({
      coverageId:
        match[1],

      run:
        match[2]
    });

  }

  if (!couvertures.length) {

    throw new Error(
      "Aucun coverage AROME P2D disponible"
    );

  }

  couvertures.sort(
    (a, b) =>
      a.run.localeCompare(b.run)
  );

  const dernier =
    couvertures[
      couvertures.length - 1
    ];


  // --------------------------------------------------
  // 3. RUN -> ISO
  // --------------------------------------------------

  const runIso =
    dernier.run.replace(
      /^(\d{4}-\d{2}-\d{2}T\d{2})\.(\d{2})\.(\d{2})Z$/,
      "$1:$2:$3Z"
    );


  // --------------------------------------------------
  // 4. ECHEANCE +48 H
  // --------------------------------------------------

  const echeance =
    new Date(
      new Date(runIso).getTime() +
      48 * 60 * 60 * 1000
    )
      .toISOString()
      .replace(
        ".000Z",
        "Z"
      );


  // --------------------------------------------------
  // 5. EMPRISE DES 9 POINTS
  // --------------------------------------------------

  const latMin =
    Math.floor(
      Math.min(
        ...FORECAST_POINTS.map(
          p => p.latitude
        )
      ) * 100
    ) / 100;

  const latMax =
    Math.ceil(
      Math.max(
        ...FORECAST_POINTS.map(
          p => p.latitude
        )
      ) * 100
    ) / 100;

  const lonMin =
    Math.floor(
      Math.min(
        ...FORECAST_POINTS.map(
          p => p.longitude
        )
      ) * 100
    ) / 100;

  const lonMax =
    Math.ceil(
      Math.max(
        ...FORECAST_POINTS.map(
          p => p.longitude
        )
      ) * 100
    ) / 100;


  // --------------------------------------------------
  // 6. GETCOVERAGE
  // --------------------------------------------------

  const params =
    new URLSearchParams();

  params.set(
    "service",
    "WCS"
  );

  params.set(
    "version",
    "2.0.1"
  );

  params.set(
    "coverageid",
    dernier.coverageId
  );

  params.append(
    "subset",
    `time(${echeance})`
  );

  params.append(
    "subset",
    `lat(${latMin},${latMax})`
  );

  params.append(
    "subset",
    `long(${lonMin},${lonMax})`
  );

  params.set(
    "format",
    "image/tiff"
  );


  const coverageResponse =
    await fetch(
      BASE +
      "/GetCoverage?" +
      params.toString(),
      {
        headers: {
          apikey:
            env.METEOFRANCE_AROME_API_KEY
        }
      }
    );


  const buffer =
    await coverageResponse.arrayBuffer();


  if (!coverageResponse.ok) {

    throw new Error(
      `AROME GetCoverage ${coverageResponse.status}: ` +
      new TextDecoder().decode(
        buffer
      )
    );

  }


  // --------------------------------------------------
  // 7. LECTURE GEOTIFF
  // --------------------------------------------------

  const tiff =
    await GeoTIFF.fromArrayBuffer(
      buffer
    );

  const image =
    await tiff.getImage();

  const width =
    image.getWidth();

  const origin =
    image.getOrigin();

  const resolution =
    image.getResolution();
console.log("GEOTIFF DEBUG", {
  width,
  height: image.getHeight(),
  origin,
  resolution,
  bbox: image.getBoundingBox()
});
  const raster =
    await image.readRasters({
      interleave: true
    });


  // --------------------------------------------------
  // 8. EXTRACTION
  // --------------------------------------------------

  const points =
    FORECAST_POINTS.map(
      point => {

        const colonne =
          Math.floor(
            (
              point.longitude -
              origin[0]
            ) /
            resolution[0]
          );

        const ligne =
          Math.floor(
            (
              point.latitude -
              origin[1]
            ) /
            resolution[1]
          );

        const index =
          ligne * width +
          colonne;

        const valeur =
          Number(
            raster[index]
          );

        return {

          nom:
            point.nom,

          bassin:
            point.bassin,

          position:
            point.position,

          pluie_mm:
            Number.isFinite(
              valeur
            )
              ? Math.round(
                  valeur * 10
                ) / 10
              : null

        };

      }
    );


  console.log(
    "AROME OK",
    dernier.run,
    echeance,
    points
  );


  // --------------------------------------------------
  // 9. STOCKAGE
  // --------------------------------------------------

  await env.RADAR.put(
    "forecast_rain",
    JSON.stringify({

      updated:
        new Date().toISOString(),

      modele:
        "AROME",

      run:
        dernier.run,

      echeance_48h:
        echeance,

      points

    })
  );

}
// ==================================================
// ARPEGE
// ==================================================

async function collectePrevisionsARPEGE(env) {

  const BASE =
    "https://public-api.meteofrance.fr/public/arpege/wcs/" +
    "MF-NWP-GLOBAL-ARPEGE-01-EUROPE-WCS";

  // --------------------------------------------------
  // Récupération du dernier P4D disponible
  // --------------------------------------------------

  const capResponse = await fetch(
    BASE +
    "/GetCapabilities" +
    "?service=WCS&version=2.0.1&language=fre",
    {
      headers: {
        apikey: env.METEOFRANCE_ARPEGE_API_KEY
      }
    }
  );

  const catalogue = await capResponse.text();

  console.log(
    "ARPEGE GetCapabilities",
    capResponse.status
  );

  if (!capResponse.ok) {
    throw new Error(
      `ARPEGE GetCapabilities ${capResponse.status}: ${catalogue}`
    );
  }

  const regex =
    /<wcs:CoverageId>(TOTAL_WATER_PRECIPITATION__GROUND_OR_WATER_SURFACE___(\d{4}-\d{2}-\d{2}T\d{2}\.\d{2}\.\d{2}Z)_P4D)<\/wcs:CoverageId>/g;

  const couvertures = [];

  for (const match of catalogue.matchAll(regex)) {

    couvertures.push({
      coverageId: match[1],
      run: match[2]
    });

  }

  if (!couvertures.length) {
    throw new Error(
      "Aucun coverage ARPEGE P4D disponible"
    );
  }

  couvertures.sort(
    (a, b) =>
      a.run.localeCompare(b.run)
  );

  const dernier =
    couvertures[couvertures.length - 1];

  // --------------------------------------------------
  // Échéance +96 h
  // --------------------------------------------------

  const runIso =
    dernier.run.replace(
      /^(.*T\d{2})\.(\d{2})\.(\d{2})Z$/,
      "$1:$2:$3Z"
    );

  const echeance =
    new Date(
      new Date(runIso).getTime() +
      96 * 60 * 60 * 1000
    )
      .toISOString()
      .replace(".000Z", "Z");

  // --------------------------------------------------
  // Emprise autour des 9 points
  // --------------------------------------------------

  const latMin =
    Math.floor(
      Math.min(
        ...FORECAST_POINTS.map(
          p => p.latitude
        )
      ) * 10
    ) / 10;

  const latMax =
    Math.ceil(
      Math.max(
        ...FORECAST_POINTS.map(
          p => p.latitude
        )
      ) * 10
    ) / 10;

  const lonMin =
    Math.floor(
      Math.min(
        ...FORECAST_POINTS.map(
          p => p.longitude
        )
      ) * 10
    ) / 10;

  const lonMax =
    Math.ceil(
      Math.max(
        ...FORECAST_POINTS.map(
          p => p.longitude
        )
      ) * 10
    ) / 10;

  const params =
    new URLSearchParams();

  params.set(
    "service",
    "WCS"
  );

  params.set(
    "version",
    "2.0.1"
  );

  params.set(
    "coverageId",
    dernier.coverageId
  );

  params.set(
    "format",
    "image/tiff"
  );

  params.append(
    "subset",
    `long(${lonMin},${lonMax})`
  );

  params.append(
    "subset",
    `lat(${latMin},${latMax})`
  );

  params.append(
    "subset",
    `time(${echeance})`
  );

  // --------------------------------------------------
  // Téléchargement TIFF
  // --------------------------------------------------

  const response =
    await fetch(
      BASE +
      "/GetCoverage?" +
      params.toString(),
      {
        headers: {
          apikey:
            env.METEOFRANCE_ARPEGE_API_KEY
        }
      }
    );

  const buffer =
    await response.arrayBuffer();

  if (!response.ok) {
    throw new Error(
      `ARPEGE GetCoverage ${response.status}: ` +
      new TextDecoder().decode(buffer)
    );
  }

  // --------------------------------------------------
  // Lecture du TIFF ARPEGE
  // --------------------------------------------------

  const tiff =
    lireTIFFARPEGE(buffer);

  // --------------------------------------------------
  // Extraction des 9 points
  // --------------------------------------------------

  const points =
    FORECAST_POINTS.map(point => {

      let colonne =
        Math.round(
          (
            point.longitude -
            tiff.origineLon
          ) /
          tiff.pixelSizeX
        );

      let ligne =
        Math.round(
          (
            tiff.origineLat -
            point.latitude
          ) /
          tiff.pixelSizeY
        );

      colonne =
        Math.max(
          0,
          Math.min(
            tiff.width - 1,
            colonne
          )
        );

      ligne =
        Math.max(
          0,
          Math.min(
            tiff.height - 1,
            ligne
          )
        );

      const index =
        ligne *
        tiff.width +
        colonne;

      const valeur =
        tiff.valeurs[index];

      return {
        nom: point.nom,
        bassin: point.bassin,
        position: point.position,
        pluie_mm:
          Number.isFinite(valeur)
            ? Math.round(
                valeur * 10
              ) / 10
            : null
      };

    });

  console.log(
    "ARPEGE OK",
    dernier.run,
    echeance,
    points
  );

  // --------------------------------------------------
  // Stockage
  // --------------------------------------------------

  const ancien =
    await env.RADAR.get(
      "forecast_rain",
      "json"
    );

  const previsions =
    ancien || {};

  previsions.arpege = {
    modele: "ARPEGE",
    run: dernier.run,
    echeance_96h: echeance,
    points
  };

  previsions.updated =
    new Date().toISOString();
console.log(
  "ARPEGE POINTS :",
  JSON.stringify(points)
);
  await env.RADAR.put(
    "forecast_rain",
    JSON.stringify(
      previsions
    )
  );
}


// ==================================================
// LECTEUR TIFF ARPEGE
// ==================================================

function lireTIFFARPEGE(buffer) {

  const data =
    new DataView(buffer);

  // TIFF little endian
  const littleEndian =
    data.getUint16(0, true) === 0x4949;

  if (!littleEndian) {
    throw new Error(
      "TIFF ARPEGE non little-endian"
    );
  }

  if (
    data.getUint16(2, true) !== 42
  ) {
    throw new Error(
      "TIFF ARPEGE invalide"
    );
  }

  const ifdOffset =
    data.getUint32(4, true);

  const nombreTags =
    data.getUint16(
      ifdOffset,
      true
    );

  const tags = {};

  for (
    let i = 0;
    i < nombreTags;
    i++
  ) {

    const offset =
      ifdOffset +
      2 +
      i * 12;

    const tag =
      data.getUint16(
        offset,
        true
      );

    const type =
      data.getUint16(
        offset + 2,
        true
      );

    const count =
      data.getUint32(
        offset + 4,
        true
      );

    const tailleType = {
      1: 1,
      2: 1,
      3: 2,
      4: 4,
      5: 8,
      12: 8
    }[type];

    if (!tailleType) {
      continue;
    }

    const taille =
      tailleType * count;

    let position;

    if (taille <= 4) {
      position =
        offset + 8;
    } else {
      position =
        data.getUint32(
          offset + 8,
          true
        );
    }

    if (
      tag === 256 ||
      tag === 257 ||
      tag === 273 ||
      tag === 278 ||
      tag === 279 ||
      tag === 339
    ) {

      tags[tag] =
        lireValeursTIFF(
          data,
          position,
          type,
          count
        );

    }

    if (
      tag === 33550 ||
      tag === 33922
    ) {

      tags[tag] =
        lireValeursTIFF(
          data,
          position,
          type,
          count
        );

    }

  }

  const width =
    Number(
      Array.isArray(tags[256])
        ? tags[256][0]
        : tags[256]
    );

  const height =
    Number(
      Array.isArray(tags[257])
        ? tags[257][0]
        : tags[257]
    );

  const stripOffset =
    Number(
      Array.isArray(tags[273])
        ? tags[273][0]
        : tags[273]
    );

  const bitsPerSample =
    Number(
      Array.isArray(tags[258])
        ? tags[258][0]
        : tags[258] || 64
    );

  const sampleFormat =
    Number(
      Array.isArray(tags[339])
        ? tags[339][0]
        : tags[339] || 3
    );

  if (
    bitsPerSample !== 64 ||
    sampleFormat !== 3
  ) {
    throw new Error(
      `Format TIFF ARPEGE inattendu : ` +
      `${bitsPerSample} bits / format ${sampleFormat}`
    );
  }

  const pixelScale =
    tags[33550];

  const tiepoint =
    tags[33922];

  if (
    !pixelScale ||
    !tiepoint
  ) {
    throw new Error(
      "Géoréférencement TIFF ARPEGE absent"
    );
  }

  const pixelSizeX =
    Number(pixelScale[0]);

  const pixelSizeY =
    Number(pixelScale[1]);

  const origineLon =
    Number(tiepoint[3]);

  const origineLat =
    Number(tiepoint[4]);

  const nombrePixels =
    width * height;

  const valeurs =
    new Float64Array(
      nombrePixels
    );

  for (
    let i = 0;
    i < nombrePixels;
    i++
  ) {

    valeurs[i] =
      data.getFloat64(
        stripOffset +
        i * 8,
        true
      );

  }

  return {
    width,
    height,
    pixelSizeX,
    pixelSizeY,
    origineLon,
    origineLat,
    valeurs
  };
}


// ==================================================
// LECTURE VALEURS TIFF
// ==================================================

function lireValeursTIFF(
  data,
  position,
  type,
  count
) {

  const valeurs = [];

  for (
    let i = 0;
    i < count;
    i++
  ) {

    if (type === 3) {

      valeurs.push(
        data.getUint16(
          position + i * 2,
          true
        )
      );

    } else if (type === 4) {

      valeurs.push(
        data.getUint32(
          position + i * 4,
          true
        )
      );

    } else if (type === 5) {

      const num =
        data.getUint32(
          position + i * 8,
          true
        );

      const den =
        data.getUint32(
          position +
          i * 8 +
          4,
          true
        );

      valeurs.push(
        den
          ? num / den
          : 0
      );

    } else if (type === 12) {

      valeurs.push(
        data.getFloat64(
          position + i * 8,
          true
        )
      );

    } else if (type === 1) {

      valeurs.push(
        data.getUint8(
          position + i
        )
      );

    }

  }

  return valeurs;
}

// ==================================================
// VIGICRUES
// ==================================================

async function getDebit(station) {

  const url =
    `https://www.vigicrues.gouv.fr/services/observations.json` +
    `?CdStationHydro=${station}` +
    `&GrdSerie=Q` +
    `&FormatDate=iso`;

  const response = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; MeteoHydroTurraque/1.0)"
    }
  });

  if (!response.ok) {
    throw new Error(
      `Vigicrues HTTP ${response.status}`
    );
  }

  const data = await response.json();

  const observations =
    data?.Serie?.ObssHydro;

  if (
    !Array.isArray(observations) ||
    observations.length === 0
  ) {
    throw new Error(
      `Aucune observation pour ${station}`
    );
  }

  const derniere =
    observations[observations.length - 1];

  if (!derniere) {
    throw new Error(
      `Aucune observation pour ${station}`
    );
  }

  return {
    debit: Number(derniere.ResObsHydro),
    dateObservation: derniere.DtObsHydro
  };
}



// ==================================================
// COLLECTE VIGICRUES 
// ==================================================

async function collecteEtStockage(env) {

  const trieSurBaise =
  await getDebit(
    "O650251001"
  );

const saintJeanPoutge =
  await getDebit(
    "O661291001"
  );

  // --------------------------------------------------
  // HEURE DE COLLECTE
  // --------------------------------------------------

  const maintenant =
    new Date();

  const heure =
    new Date(
      maintenant
    );

  heure.setMinutes(
    0,
    0,
    0
  );


  const cle =
    "debit_" +
    heure.toISOString();


  // --------------------------------------------------
  // OBJET MESURE
  // --------------------------------------------------

  const mesure = {

    collecte:
      maintenant.toISOString(),

     trieSurBaise: {
    debit:
      trieSurBaise.debit,
    observation:
      trieSurBaise.dateObservation
  },

  saintJeanPoutge: {
    debit:
      saintJeanPoutge.debit,
    observation:
      saintJeanPoutge.dateObservation
  }
  };


   // --------------------------------------------------
  // STOCKAGE
  // --------------------------------------------------

  await env[
    "HYDRO"
  ].put(
    cle,
    JSON.stringify(
      mesure
    )
  );

// --------------------------------------------------
// LIMITE HISTORIQUE : 30 JOURS
// --------------------------------------------------

const limiteDebit =
  heure.getTime() - 30 * 24 * 60 * 60 * 1000;

// ==================================================
// HISTORIQUE DEBIT TRIE-SUR-BAISE
// ==================================================

let historiqueTrieSurBaise =
  await env["HYDRO"].get(
    "trie_sur_baise_history",
    "json"
  );

if (!Array.isArray(historiqueTrieSurBaise)) {
  historiqueTrieSurBaise = [];
}

const nouvelleMesureTrieSurBaise = {
  t: heure.toISOString(),
  debit: trieSurBaise.debit
};

const indexExistanteTrieSurBaise =
  historiqueTrieSurBaise.findIndex(
    m => m.t === nouvelleMesureTrieSurBaise.t
  );

if (indexExistanteTrieSurBaise >= 0) {
  historiqueTrieSurBaise[indexExistanteTrieSurBaise] =
    nouvelleMesureTrieSurBaise;
} else {
  historiqueTrieSurBaise.push(
    nouvelleMesureTrieSurBaise
  );
}

historiqueTrieSurBaise =
  historiqueTrieSurBaise
    .filter(m => new Date(m.t).getTime() >= limiteDebit)
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    .slice(-720);

await env["HYDRO"].put(
  "trie_sur_baise_history",
  JSON.stringify(historiqueTrieSurBaise)
);


// ==================================================
// HISTORIQUE DEBIT SAINT-JEAN-POUTGE
// ==================================================

let historiqueSaintJeanPoutge =
  await env["HYDRO"].get(
    "saint_jean_poutge_history",
    "json"
  );

if (!Array.isArray(historiqueSaintJeanPoutge)) {
  historiqueSaintJeanPoutge = [];
}

const nouvelleMesureSaintJeanPoutge = {
  t: heure.toISOString(),
  debit: saintJeanPoutge.debit
};

const indexExistanteSaintJeanPoutge =
  historiqueSaintJeanPoutge.findIndex(
    m => m.t === nouvelleMesureSaintJeanPoutge.t
  );

if (indexExistanteSaintJeanPoutge >= 0) {
  historiqueSaintJeanPoutge[indexExistanteSaintJeanPoutge] =
    nouvelleMesureSaintJeanPoutge;
} else {
  historiqueSaintJeanPoutge.push(
    nouvelleMesureSaintJeanPoutge
  );
}

historiqueSaintJeanPoutge =
  historiqueSaintJeanPoutge
    .filter(m => new Date(m.t).getTime() >= limiteDebit)
    .sort((a, b) => new Date(a.t).getTime() - new Date(b.t).getTime())
    .slice(-720);

await env["HYDRO"].put(
  "saint_jean_poutge_history",
  JSON.stringify(historiqueSaintJeanPoutge)
);
  // --------------------------------------------------
  // AROME
  // --------------------------------------------------

  console.log(
    "AVANT AROME"
  );

  try {

    console.log(
      "AROME START"
    );

    await collectePrevisionsAROME(
      env
    );

    console.log(
      "AROME FIN"
    );

  } catch (error) {

    console.log(
      "ERREUR AROME",
      error.message
    );

  }


  // --------------------------------------------------
  // ARPEGE
  // --------------------------------------------------

  console.log(
    "AVANT ARPEGE"
  );

  try {

    console.log(
      "ARPEGE START"
    );

    await collectePrevisionsARPEGE(
      env
    );

    console.log(
      "ARPEGE FIN"
    );

  } catch (error) {

    console.log(
      "ERREUR ARPEGE",
      error.message
    );

  }
}


// ==================================================
// AFFICHAGE
// ==================================================

async function afficherPage(
  env,
  periode = "tout"
) {
  const kv = env.HYDRO;

  // Récupération de toutes les clés debit_ (pagination KV)
  let curseur = undefined;
  let cles = [];

  do {
    const options = {
      prefix: "debit_",
      limit: 1000
    };

    if (curseur) {
      options.cursor = curseur;
    }

    const liste = await kv.list(options);

    const nouvellesCles = (liste.keys || [])
      .filter(key =>
        /^debit_\d{4}-\d{2}-\d{2}T/.test(key.name)
      )
      .map(key => key.name);

    cles.push(...nouvellesCles);

    curseur = liste.list_complete
      ? undefined
      : liste.cursor;

  } while (curseur);

  if (cles.length === 0) {
    return pageVide();
  }

  // Sélection de la clé la plus récente
  cles.sort();

  const derniereCle = cles[cles.length - 1];

  const texte = await kv.get(derniereCle);

  if (!texte) {
    return pageVide();
  }

  const mesure = JSON.parse(texte);
    JSON.parse(
      texte
    );


  // --------------------------------------------------
  // RADAR
  // --------------------------------------------------

  const historiqueRadar =
    await env.RADAR.get(
      "radar_history",
      "json"
    );


  let radar = [];


  if (
    Array.isArray(
      historiqueRadar
    ) &&
    historiqueRadar.length > 0
  ) {

    const derniere =
      historiqueRadar[
        historiqueRadar.length - 1
      ];


    const maintenant =
      new Date(
        derniere.t
      ).getTime();


    radar =
      RADAR_POINTS.map(
        (point, i) => ({

          nom:
            point.nom,

          bassin:
            point.bassin,

          position:
            point.position,

          ...calculerCumuls(
            historiqueRadar,
            i,
            maintenant
          )

        })
      );

  }

// --------------------------------------------------
// HISTORIQUE DEBIT TRIE-SUR-BAISE
// --------------------------------------------------

const historiqueTrieSurBaise =
  await env["HYDRO"].get(
    "trie_sur_baise_history",
    "json"
  );

const trieSurBaiseGraphComplet =
  Array.isArray(historiqueTrieSurBaise)
    ? historiqueTrieSurBaise
    : [];


// --------------------------------------------------
// HISTORIQUE DEBIT SAINT-JEAN-POUTGE
// --------------------------------------------------

const historiqueSaintJeanPoutge =
  await env["HYDRO"].get(
    "saint_jean_poutge_history",
    "json"
  );

const saintJeanPoutgeGraphComplet =
  Array.isArray(historiqueSaintJeanPoutge)
    ? historiqueSaintJeanPoutge
    : [];


// --------------------------------------------------
// FILTRE PERIODE DU GRAPHE
// --------------------------------------------------

const dureesPeriode = {

  "2j":
    2 * 24 * 60 * 60 * 1000,

  "5j":
    5 * 24 * 60 * 60 * 1000,

  "15j":
    15 * 24 * 60 * 60 * 1000

};


// Par défaut : tout l'historique disponible

let trieSurBaiseGraph =
  trieSurBaiseGraphComplet;

let saintJeanPoutgeGraph =
  saintJeanPoutgeGraphComplet;


if (
  dureesPeriode[periode] &&
  trieSurBaiseGraphComplet.length > 0
) {

  const derniereDate =
    new Date(
      trieSurBaiseGraphComplet[
        trieSurBaiseGraphComplet.length - 1
      ].t
    ).getTime();

  const limite =
    derniereDate -
    dureesPeriode[periode];


trieSurBaiseGraph =
  trieSurBaiseGraphComplet.filter(
    p => new Date(p.t).getTime() >= limite
  );


  saintJeanPoutgeGraph =
    saintJeanPoutgeGraphComplet.filter(
      p => new Date(p.t).getTime() >= limite
    );

}
  
  // --------------------------------------------------
  // PREVISIONS
  // --------------------------------------------------

  const previsions =
    await env.RADAR.get(
      "forecast_rain",
      "json"
    );


  return pageAvecMesure(
    mesure,
    radar,
     trieSurBaiseGraph,
    saintJeanPoutgeGraph,
    previsions,
    periode
  );

}
// ==================================================
// PAGE VIDE
// ==================================================

function pageVide() {

  return `

<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<title>
Météo hydro Turraque
</title>

<style>

html,
body {

  margin:0;

  width:100%;

  height:100%;

  font-family:
    Arial,
    sans-serif;

  background:
    #f3f5f7;

}

body {

  padding:
    12px;

}

.card {

  background:
    white;

  padding:
    20px;

  border-radius:
    8px;

}

</style>

</head>

<body>

<div class="card">

<h1>
Météo hydro Turraque
</h1>

<p>
Aucune mesure enregistrée.
</p>

</div>

</body>

</html>

`;

}


// ==================================================
// PAGE PRINCIPALE
// ==================================================

function pageAvecMesure(
  mesure,
  radar,
  trieSurBaiseGraph,
  saintJeanPoutgeGraph,
  previsions,
  periode = "tout"
) {


  // --------------------------------------------------
  // FORMAT DATE VIGICRUES
  // --------------------------------------------------

  function formatDate(date) {

    if (!date) {

      return "—";

    }

    return new Date(
      date
    ).toLocaleString(
      "fr-FR",
      {
        timeZone:
          "Europe/Paris",

        day:
          "2-digit",

        month:
          "2-digit",

        year:
          "numeric",

        hour:
          "2-digit",

        minute:
          "2-digit"

      }
    );

  }


  // --------------------------------------------------
  // FORMAT DEBIT
  // --------------------------------------------------

  function formatDebit(value) {

    if (
      value === null ||
      value === undefined ||
      Number.isNaN(
        Number(value)
      )
    ) {

      return "—";

    }

    return Number(value)
      .toFixed(1);

  }


 

// ==================================================
// GRAPHE DEBIT — TRIE-SUR-BAÏSE + SAINT-JEAN-POUTGE
// ==================================================

const graph =
  (() => {

    if (
      !Array.isArray(trieSurBaiseGraph) ||
      trieSurBaiseGraph.length < 2
    ) {

      return `
<text
  x="400"
  y="130"
  text-anchor="middle"
  fill="#777"
  font-size="14"
>
Données insuffisantes
</text>
`;

    }


    const largeur = 800;
    const hauteur = 260;

    const margeGauche = 55;
    const margeDroite = 15;
    const margeHaut = 15;
    const margeBas = 100;

    const graphW =
      largeur -
      margeGauche -
      margeDroite;

    const graphH =
      hauteur -
      margeHaut -
      margeBas;
    const tempsDebut =
    new Date(
      trieSurBaiseGraph[0].t
    ).getTime();

    const tempsFin =
      new Date(
        trieSurBaiseGraph[
          trieSurBaiseGraph.length - 1
        ].t
      ).getTime();

    const dureeTemps =
      Math.max(
        tempsFin - tempsDebut,
        1
      );

    function positionX(date) {

      const temps =
        new Date(
          date
        ).getTime();

      return (
        margeGauche +
        (
          (temps - tempsDebut) /
          dureeTemps
        ) *
        graphW
      );

    }

  // --------------------------------------------------
  // DONNEES TRIE-SUR-BAÏSE
  // --------------------------------------------------
  
  const valeursTrieSurBaise =
    trieSurBaiseGraph.map(
      p =>
        Number(p.debit)
    );
// --------------------------------------------------
// DONNEES SAINT-JEAN-POUTGE
// --------------------------------------------------

const valeursSaintJeanPoutge =
  Array.isArray(saintJeanPoutgeGraph)
    ? saintJeanPoutgeGraph.map(
        p =>
          Number(p.debit)
      )
    : [];


// --------------------------------------------------
// ECHELLE COMMUNE
// --------------------------------------------------

const toutesLesValeurs =
  [
    ...valeursTrieSurBaise,
    ...valeursSaintJeanPoutge
  ];




    const minDebit =
      Math.min(
        ...toutesLesValeurs
      );


    const maxDebit =
      Math.max(
        ...toutesLesValeurs
      );


    const amplitude =
      Math.max(
        maxDebit -
        minDebit,
        1
      );


// --------------------------------------------------
// COURBE TRIE-SUR-BAÏSE
// --------------------------------------------------

const pointsTrieSurBaise =
  trieSurBaiseGraph
    .map(
      (p, i) => {

            const x = 
              positionX(p.t);


            const y =
              margeHaut +
              graphH -
              (
                (
                  Number(p.debit) -
                  minDebit
                ) /
                amplitude
              ) *
              graphH;


            return (
              `${x.toFixed(1)},` +
              `${y.toFixed(1)}`
            );

          }
        )
        .join(" ");


    // --------------------------------------------------
    // COURBE SAINT-JEAN-POUTGE
    // --------------------------------------------------

    let pointsSaintJeanPoutge = "";


    if (
      valeursSaintJeanPoutge.length >= 2
    ) {

      pointsSaintJeanPoutge =
        saintJeanPoutgeGraph
          .map(
            (p, i) => {

              const x =
                positionX(p.t);


              const y =
                margeHaut +
                graphH -
                (
                  (
                    Number(p.debit) -
                    minDebit
                  ) /
                  amplitude
                ) *
                graphH;


              return (
                `${x.toFixed(1)},` +
                `${y.toFixed(1)}`
              );

            }
          )
          .join(" ");

    }


    return `

<line
  x1="${margeGauche}"
  y1="${margeHaut}"
  x2="${margeGauche}"
  y2="${margeHaut + graphH}"
  stroke="#999"
/>


<line
  x1="${margeGauche}"
  y1="${margeHaut + graphH}"
  x2="${margeGauche + graphW}"
  y2="${margeHaut + graphH}"
  stroke="#999"
/>


<!-- ECHELLE MIN -->

<text
  x="${margeGauche - 8}"
  y="${margeHaut + graphH}"
  text-anchor="end"
  dominant-baseline="middle"
  font-size="11"
  fill="#666"
>
${minDebit.toFixed(0)}
</text>


<!-- ECHELLE MAX -->

<text
  x="${margeGauche - 8}"
  y="${margeHaut}"
  text-anchor="end"
  dominant-baseline="middle"
  font-size="11"
  fill="#666"
>
${maxDebit.toFixed(0)}
</text>


<!-- COURBE Trie sur Baïse -->

<polyline
  points="${pointsTrieSurBaise}"
  fill="none"
  stroke="#1976d2"
  stroke-width="2"
/>


<!-- COURBE SAINT-JEAN-POUTGE -->

${
  pointsSaintJeanPoutge
    ? `
<polyline
  points="${pointsSaintJeanPoutge}"
  fill="none"
  stroke="#e67e22"
  stroke-width="2"
/>
`
    : ""
}


<!-- ZONE INTERACTIVE -->

<rect
  id="debitHitbox"
  x="${margeGauche}"
  y="${margeHaut}"
  width="${graphW}"
  height="${graphH}"
  fill="transparent"
  pointer-events="all"
  style="cursor:crosshair"
/>


<!-- GUIDE -->

<line
  id="debitGuide"
  x1="0"
  y1="${margeHaut}"
  x2="0"
  y2="${margeHaut + graphH}"
  stroke="#999"
  stroke-dasharray="4 4"
  visibility="hidden"
  pointer-events="none"
/>


<!-- POINT TRIE SUR BAISE -->

<circle
  id="debitPoint"
  cx="0"
  cy="0"
  r="4"
  fill="#1976d2"
  visibility="hidden"
  pointer-events="none"
/>

<circle
  id="debitPointSaintJeanPoutge"
  cx="0"
  cy="0"
  r="4"
  fill="#e67e22"
  visibility="hidden"
  pointer-events="none"
/>

<!-- DATES -->

${(() => {
  const debut = new Date(trieSurBaiseGraph[0].t);
  const fin = new Date(trieSurBaiseGraph[trieSurBaiseGraph.length - 1].t);

  const debutMs = debut.getTime();
  const finMs = fin.getTime();

  const resultat = [];

  // Première graduation à une heure UTC multiple de 4
  let temps = Math.ceil(debutMs / (4 * 3600000)) * (4 * 3600000);

  while (temps <= finMs) {
    const date = new Date(temps);

    const x =
      margeGauche +
      ((temps - debutMs) / (finMs - debutMs)) * graphW;

resultat.push(
  '<text x="' + x + '" y="' + (hauteur - margeBas + 15) +
  '" font-size="10" fill="#666" text-anchor="end" ' +
  'transform="rotate(-90 ' + x + ' ' + (hauteur - margeBas + 15) + ')">' +
  date.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    year: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Europe/Paris"
  }).replace(" ", "-").replace(":", "-") +
  '</text>'
);

    temps += 4 * 3600000;
  }

  return resultat.join("");
})()}




<text
  x="${largeur - margeDroite}"
  y="${hauteur - margeBas + 15}"
  text-anchor="end"
  font-size="10"
  fill="#666"
  transform="rotate(-90 ${largeur - margeDroite} ${hauteur - margeBas + 15})"
>
${new Date(
  trieSurBaiseGraph[
    trieSurBaiseGraph.length - 1
  ].t
).toLocaleString("fr-FR", {
  day: "2-digit",
  month: "2-digit",
  year: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: "Europe/Paris"
}).replace(" ", "-").replace(":", "-")}
</text>

`;

  })();


  // ==================================================
  // TABLEAU RADAR
  // ==================================================

  const tableauRadar =
    Array.isArray(radar) &&
    radar.length > 0

      ? `

<div class="radar-table">

<table>

<tr>

<th>
Bassin
</th>

<th>
Position
</th>

<th>
Point
</th>

<th>
12 h
</th>

<th>
24 h
</th>

<th>
2 j
</th>

<th>
6 j
</th>

<th>
15 j
</th>

</tr>


${radar.map(
  point => `

<tr>

<td>
${point.bassin}
</td>

<td>
${point.position}
</td>

<td>
${point.nom}
</td>

<td>
${point["12 h"]?.toFixed(1) ?? "—"} mm
</td>

<td>
${point["24 h"]?.toFixed(1) ?? "—"} mm
</td>

<td>
${point["2 j"]?.toFixed(1) ?? "—"} mm
</td>

<td>
${point["6 j"]?.toFixed(1) ?? "—"} mm
</td>

<td>
${point["15 j"]?.toFixed(1) ?? "—"} mm
</td>

</tr>

`
).join("")}

</table>

</div>

`

      : `

<div class="placeholder">

Données radar indisponibles

</div>

`;


 // Prévisions chargées mais pas encore affichées
// ==================================================
// TABLEAU PLUIE : RADAR + AROME + ARPEGE
// ==================================================

const pointsAROME =
  previsions &&
  Array.isArray(previsions.points)
    ? previsions.points
    : [];

const pointsARPEGE =
  previsions &&
  previsions.arpege &&
  Array.isArray(previsions.arpege.points)
    ? previsions.arpege.points
    : [];

const trouverPoint =
  (liste, nom) =>
    liste.find(
      point => point.nom === nom
    );
const tableauPrevisions =
  (pointsAROME.length > 0 || pointsARPEGE.length > 0)
    ? `

<div class="radar-table">

<h2>
Précipitations prévues (source : Météofrance)
</h2>

<table>

<tr>

<th>
Bassin
</th>

<th>
Position
</th>

<th>
Point
</th>

<th>
AROME 48 h
</th>

<th>
ARPEGE 4 j
</th>

</tr>


${RADAR_POINTS.map(
  point => {

    const arome =
      trouverPoint(
        pointsAROME,
        point.nom
      );

    const arpege =
      trouverPoint(
        pointsARPEGE,
        point.nom
      );

    return `

<tr>

<td>
${point.bassin}
</td>

<td>
${point.position}
</td>

<td>
${point.nom}
</td>

<td>
${arome?.pluie_mm != null
  ? Number(arome.pluie_mm).toFixed(1) + " mm"
  : "—"}
</td>

<td>
${arpege?.pluie_mm != null
  ? Number(arpege.pluie_mm).toFixed(1) + " mm"
  : "—"}
</td>

</tr>

`;

  }
).join("")}

</table>

</div>

`
    : `

<div class="placeholder">

Prévisions de précipitations indisponibles

</div>

`;
  // ==================================================
  // PAGE
  // ==================================================

  return `

<!DOCTYPE html>

<html lang="fr">

<head>

<meta charset="UTF-8">

<meta name="viewport"
      content="width=device-width, initial-scale=1.0">

<meta http-equiv="refresh"
      content="300">

<title>
Meteo hydro Turraque
</title>


<style>

* {

  box-sizing:
    border-box;

}


html,
body {

  margin:0;

  padding:0;

  width:100%;

  height:100%;

  overflow:hidden;

  font-family:
    Arial,
    sans-serif;

  background:
    #f3f5f7;

  color:
    #222;

}


body {

  padding:
    12px;

}


.dashboard {

  height:
    100%;

  display:
    grid;

  grid-template-columns:
    1fr 1fr;

  grid-template-rows:
   auto auto auto 1fr;

  grid-template-areas:
    "header header"
    "debit forecast"
    "sgl radar"
    "graph radar";

  gap:
    10px;

}


.header {

  grid-area:
    header;

  display:
    flex;

  justify-content:
    space-between;

  align-items:
    center;

  background:
    white;

  padding:
    10px 16px;

  border-radius:
    8px;

}


.header h1 {

  margin:
    0;

  font-size:
    24px;

}
.debit-card {
  grid-area: debit;
}

.graph-card {
  grid-area: graph;
}

.forecast-card {
  grid-area: forecast;
}

.radar-card {
  grid-area: radar;
}

.card {

  background:
    white;

  border-radius:
    8px;

  padding:
    14px;

  overflow:
    hidden;

}

.card h2 {

  margin:
    0 0 10px 0;

  font-size:
    17px;

}


.main-value {

  font-size:
    38px;

  font-weight:
    bold;

  margin:
    4px 0 8px;

}

.subtitle {

  font-size:
    12px;

  color:
    #666;

}


table {

  width:
    100%;

  border-collapse:
    collapse;

  font-size:
    13px;

}


th,
td {

  padding:
    6px 5px;

  text-align:
    left;

  border-bottom:
    1px solid #e5e5e5;

}


.total {

  font-weight:
    bold;

  font-size:
    14px;

}


.station-date {

  font-size:
    10px;

  color:
    #777;

  margin-top:
    2px;

}


.warning {

  margin-top:
    10px;

  padding:
    8px 10px;

  border-radius:
    5px;

  background:
    #fff0f0;

  color:
    #c00000;

  font-size:
    12px;

  font-weight:
    bold;

}





.placeholder {

  height:
    calc(100% - 35px);

  display:
    flex;

  align-items:
    center;

  justify-content:
    center;

  background:
    #f3f5f7;

  border-radius:
    6px;

  color:
    #777;

  font-size:
    13px;

}


.radar-table {

  overflow-x:
    auto;

  width:
    100%;

}


@media (max-width: 900px) {

  html,
  body {

    height:
      auto;

    min-height:
      100%;

    overflow:
      auto;

  }


  .dashboard {

  height:
    auto;

  grid-template-columns:
    1fr;

  grid-template-rows:
    auto;

  grid-template-areas:
    "header"
    "debit"
    "sgl"
    "forecast"
    "radar"
    "graph";

}


  .header {

    grid-column:
      1;

  }


  .card {

    overflow:
      visible;

  }

}

</style>

</head>


<body>


<div class="dashboard">


<!-- ============================================== -->
<!-- HEADER -->
<!-- ============================================== -->

<div class="header">

<h1>
Meteo hydro Turraque
</h1>

<div style="
font-size:12px;
color:#666;
">

Dernière collecte :
${formatDate(
  mesure.collecte
)}

</div>

</div>
<!-- ============================================== -->
<!-- DEBITS -->
<!-- ============================================== -->

<div class="card debit-card">

<h2>Débits Vigicrues</h2>

<div class="station-date">
Trie-sur-Baïse
</div>

<div class="main-value">
${formatDebit(mesure.trieSurBaise.debit)} m³/s
</div>

<div class="station-date">
Mesure :
${formatDate(mesure.trieSurBaise.observation)}
</div>

<hr>

<div class="station-date">
Saint-Jean-Poutge
</div>

<div class="main-value">
${formatDebit(mesure.saintJeanPoutge.debit)} m³/s
</div>

<div class="station-date">
Mesure :
${formatDate(mesure.saintJeanPoutge.observation)}
</div>

</div>
<!-- ============================================== -->
<!-- GRAPHE -->
<!-- ============================================== -->
<div class="card graph-card">

<div
  style="
    display:flex;
    align-items:center;
    justify-content:space-between;
    gap:10px;
    flex-wrap:wrap;
  "
>

<h2 style="margin:0;">
Débits
</h2>


<div
  style="
    display:flex;
    gap:5px;
    flex-wrap:wrap;
  "
>


<a
  href="?periode=2j"
  style="
    padding:5px 10px;
    border-radius:5px;
    text-decoration:none;
    font-size:12px;
    border:1px solid #ccc;
    background:${periode === "2j" ? "#1976d2" : "#f5f5f5"};
    color:${periode === "2j" ? "white" : "#333"};
  "
>
2 j
</a>


<a
  href="?periode=5j"
  style="
    padding:5px 10px;
    border-radius:5px;
    text-decoration:none;
    font-size:12px;
    border:1px solid #ccc;
    background:${periode === "5j" ? "#1976d2" : "#f5f5f5"};
    color:${periode === "5j" ? "white" : "#333"};
  "
>
5 j
</a>


<a
  href="?periode=15j"
  style="
    padding:5px 10px;
    border-radius:5px;
    text-decoration:none;
    font-size:12px;
    border:1px solid #ccc;
    background:${periode === "15j" ? "#1976d2" : "#f5f5f5"};
    color:${periode === "15j" ? "white" : "#333"};
  "
>
15 j
</a>


<a
  href="?periode=tout"
  style="
    padding:5px 10px;
    border-radius:5px;
    text-decoration:none;
    font-size:12px;
    border:1px solid #ccc;
    background:${periode === "tout" ? "#1976d2" : "#f5f5f5"};
    color:${periode === "tout" ? "white" : "#333"};
  "
>
Tout
</a>


</div>

</div>


<div
  style="
    position:relative;
    width:100%;
    height:160px;
  "
>

<svg
  id="debitGraph"
  viewBox="0 0 800 260"
  width="100%"
  height="160"
  preserveAspectRatio="none"
  style="
    background:#f8f9fa;
    border-radius:6px;
  "
>

${graph}

<line
  x1="70"
  y1="12"
  x2="90"
  y2="12"
  stroke="#1976d2"
  stroke-width="3"
/>

<text
  x="96"
  y="16"
  font-size="11"
  fill="#555"
>
Trie sur Baïse
</text>

<line
  x1="190"
  y1="12"
  x2="210"
  y2="12"
  stroke="#e67e22"
  stroke-width="3"
/>

<text
  x="216"
  y="16"
  font-size="11"
  fill="#555"
>
Saint-Jean-Poutge
</text>

</svg>



<div
  id="debitTooltip"
  style="
    position:absolute;
    display:none;
    pointer-events:none;
    background:white;
    border:1px solid #ccc;
    border-radius:5px;
    padding:7px 9px;
    font-size:12px;
    box-shadow:0 2px 6px rgba(0,0,0,.15);
    white-space:nowrap;
    z-index:10;
  "
></div>


</div>

</div>


<!-- ============================================== -->
<!-- RADAR -->
<!-- ============================================== -->

<div class="card forecast-card">

  ${tableauPrevisions}

</div>


<div class="card radar-card">

  <h2>
  Précipitations cumulées radar (source : Météofrance radar)
  </h2>

  ${tableauRadar}

</div>


</div>


<script>
(() => {
const dataTrieSurBaise =
  ${JSON.stringify(
    trieSurBaiseGraph
  )};

const dataSaintJeanPoutge =
  ${JSON.stringify(
    saintJeanPoutgeGraph
  )};


  const svg =
    document.getElementById(
      "debitGraph"
    );

  const hitbox =
    document.getElementById(
      "debitHitbox"
    );

  const point =
    document.getElementById(
      "debitPoint"
    );

const pointSaintJeanPoutge =
  document.getElementById(
    "debitPointSaintJeanPoutge"
  );

  const guide =
    document.getElementById(
      "debitGuide"
    );

  const tooltip =
    document.getElementById(
      "debitTooltip"
    );


  if (
    !svg ||
    !hitbox ||
    !dataTrieSurBaise.length
  ) {
    return;
  }


  const largeur = 800;
  const hauteur = 260;

  const margeGauche = 55;
  const margeDroite = 15;
  const margeHaut = 15;
  const margeBas = 100;


  const graphW =
    largeur -
    margeGauche -
    margeDroite;

  const graphH =
    hauteur -
    margeHaut -
    margeBas;


  // --------------------------------------------------
  // MIN / MAX DES DEUX COURBES
  // --------------------------------------------------
  
  const valeurs = [
    ...dataTrieSurBaise,
    ...dataSaintJeanPoutge
  ]
    .map(
      p =>
        Number(
          p.debit
        )
    )
    .filter(
      v =>
        Number.isFinite(v)
    );


  const minDebit =
    Math.min(
      ...valeurs
    );

  const maxDebit =
    Math.max(
      ...valeurs
    );

  const amplitude =
    Math.max(
      maxDebit -
      minDebit,
      1
    );


  // --------------------------------------------------
  // AFFICHAGE DU SURVOL
  // --------------------------------------------------

  function afficher(index) {

    const p =
      dataTrieSurBaise[index];

    if (!p) {
      return;
    }


const debut = new Date(dataTrieSurBaise[0].t).getTime();
const fin = new Date(dataTrieSurBaise[dataTrieSurBaise.length - 1].t).getTime();

const x =
  margeGauche +
  (
    (new Date(p.t).getTime() - debut) /
    (fin - debut)
  ) * graphW;


    // ------------------------------------------------
    // POINT TRIE SUR BAISE
    // ------------------------------------------------

    const y =
      margeHaut +
      graphH -
      (
        (
          Number(
            p.debit
          ) -
          minDebit
        ) /
        amplitude
      ) *
      graphH;


    point.setAttribute(
      "cx",
      x
    );

    point.setAttribute(
      "cy",
      y
    );


  // ------------------------------------------------
  // POINT SAINT-JEAN-POUTGE
  // ------------------------------------------------
  
  const pSJP =
    dataSaintJeanPoutge.find(
      q =>
        q.t === p.t
    );


    if (pSJP) {

      const ySJP =
        margeHaut +
        graphH -
        (
          (
            Number(
              pSJP.debit
            ) -
            minDebit
          ) /
          amplitude
        ) *
        graphH;


     pointSaintJeanPoutge.setAttribute(
        "cx",
        x
      );

      pointSaintJeanPoutge.setAttribute(
        "cy",
        ySJP
      );

      pointSaintJeanPoutge.setAttribute(
        "visibility",
        "visible"
      );

    } else {

      pointSaintJeanPoutge.setAttribute(
        "visibility",
        "hidden"
      );

    }


    // ------------------------------------------------
    // GUIDE VERTICAL
    // ------------------------------------------------

    guide.setAttribute(
      "x1",
      x
    );

    guide.setAttribute(
      "x2",
      x
    );


    point.setAttribute(
      "visibility",
      "visible"
    );

    guide.setAttribute(
      "visibility",
      "visible"
    );


    // ------------------------------------------------
    // DATE
    // ------------------------------------------------

    const date =
      new Date(
        p.t
      ).toLocaleString(
        "fr-FR",
        {
          day:
            "2-digit",

          month:
            "2-digit",

          year:
            "numeric",

          hour:
            "2-digit",

          minute:
            "2-digit"
        }
      );


// ------------------------------------------------
// INFOS
// ------------------------------------------------

let texteSaintJeanPoutge =
  "—";

if (pSJP) {

  texteSaintJeanPoutge =
    Number(
      pSJP.debit
    ).toFixed(1) +
    " m³/s";

    }


tooltip.innerHTML =
  "<strong>" +
  date +
  "</strong><br>" +

  "<span style='color:#1976d2'>" +
  "●" +
  "</span> " +

"Trie-sur-Baïse : " +
  Number(
    p.debit
  ).toFixed(1) +
  " m³/s<br>" +

  "<span style='color:#e67e22'>" +
  "●" +
  "</span> " +

"Saint-Jean-Poutge : " +
  texteSaintJeanPoutge;


    // ------------------------------------------------
    // POSITION TOOLTIP
    // ------------------------------------------------

    const rect =
      svg.getBoundingClientRect();


    const px =
      (
        x /
        largeur
      ) *
      rect.width;


    const py =
      (
        y /
        hauteur
      ) *
      rect.height;


    const marge =
      10;


    tooltip.style.display =
      "block";

    tooltip.style.left =
      "0px";

    tooltip.style.top =
      "0px";


    const tw =
      tooltip.offsetWidth;

    const th =
      tooltip.offsetHeight;


    let left;
    let top;


    if (
      px +
      tw +
      marge <=
      rect.width
    ) {

      left =
        px +
        marge;

    } else {

      left =
        px -
        tw -
        marge;

    }


    if (
      py -
      th -
      marge >=
      0
    ) {

      top =
        py -
        th -
        marge;

    } else {

      top =
        py +
        marge;

    }


    left =
      Math.max(
        2,
        Math.min(
          left,
          rect.width -
          tw -
          2
        )
      );


    top =
      Math.max(
        2,
        Math.min(
          top,
          rect.height -
          th -
          2
        )
      );


    tooltip.style.left =
      left + "px";

    tooltip.style.top =
      top + "px";

  }


  // --------------------------------------------------
  // MASQUER
  // --------------------------------------------------

  function masquer() {

    point.setAttribute(
      "visibility",
      "hidden"
    );

    pointSaintJeanPoutge.setAttribute(
      "visibility",
      "hidden"
    );

    guide.setAttribute(
      "visibility",
      "hidden"
    );

    tooltip.style.display =
      "none";

  }


  // --------------------------------------------------
  // POSITION SOURIS
  // --------------------------------------------------

function positionDepuisEvenement(event) {

  const rect = svg.getBoundingClientRect();

  const x =
    (event.clientX - rect.left) /
    rect.width *
    largeur;

  const debut = new Date(dataTrieSurBaise[0].t).getTime();
  const fin = new Date(dataTrieSurBaise[dataTrieSurBaise.length - 1].t).getTime();

  const tempsCible =
    debut +
    ((x - margeGauche) / graphW) * (fin - debut);

  let index = 0;
  let ecartMin = Infinity;

  dataTrieSurBaise.forEach((p, i) => {
    const ecart = Math.abs(new Date(p.t).getTime() - tempsCible);

    if (ecart < ecartMin) {
      ecartMin = ecart;
      index = i;
    }
  });

  afficher(index);
}


  svg.addEventListener(
  "mousemove",
  positionDepuisEvenement
);


svg.addEventListener(
  "mouseleave",
  masquer
);


svg.addEventListener(
  "touchstart",
  event => {

    event.preventDefault();

    positionDepuisEvenement(
      event.touches[0]
    );

  },
  {
    passive:false
  }
);


svg.addEventListener(
  "touchmove",
  event => {

    event.preventDefault();

    positionDepuisEvenement(
      event.touches[0]
    );

  },
  {
    passive:false
  }
);


svg.addEventListener(
  "touchend",
  masquer
);

})();
</script>


</body>

</html>

`;

}
