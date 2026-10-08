import h5wasm from "h5wasm";
import * as GeoTIFF from "geotiff";

const RADAR_POINTS = [
  {
    nom: "Montargis",
    bassin: "Loing",
    position: "Amont",
    latitude: 47.9978628,
    longitude: 2.7310072,
    ligne: 1312,
    colonne: 1638
  },
  {
    nom: "Nemours",
    bassin: "Loing",
    position: "Médian",
    latitude: 48.2680260,
    longitude: 2.6953079,
    ligne: 1254,
    colonne: 1630
  },
  {
    nom: "Château-Landon",
    bassin: "Loing",
    position: "Aval",
    latitude: 48.1496366,
    longitude: 2.7032718,
    ligne: 1279,
    colonne: 1632
  },
  {
    nom: "Auxerre",
    bassin: "Yonne",
    position: "Amont",
    latitude: 47.7961287,
    longitude: 3.5705790,
    ligne: 1349,
    colonne: 1763
  },
  {
    nom: "Joigny",
    bassin: "Yonne",
    position: "Médian",
    latitude: 47.9812486,
    longitude: 3.3995767,
    ligne: 1310,
    colonne: 1736
  },
  {
    nom: "Pont-sur-Yonne",
    bassin: "Yonne",
    position: "Aval",
    latitude: 48.2852895,
    longitude: 3.2045813,
    ligne: 1246,
    colonne: 1704
  },
  {
    nom: "Nogent-sur-Seine",
    bassin: "Seine",
    position: "Amont",
    latitude: 48.4924390,
    longitude: 3.4978181,
    ligne: 1199,
    colonne: 1743
  },
  {
    nom: "Montereau",
    bassin: "Seine",
    position: "Médian",
    latitude: 47.8564484,
    longitude: 2.5717138,
    ligne: 1344,
    colonne: 1616
  },
  {
    nom: "Chartrettes",
    bassin: "Seine",
    position: "Aval",
    latitude: 48.4881157,
    longitude: 2.7005289,
    ligne: 1206,
    colonne: 1628
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
    !!env.METEOFRANCE_API_KEY
  );

  const response =
    await fetch(
      url,
      {
        headers: {
          apikey:
            env.METEOFRANCE_API_KEY
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
            env.METEOFRANCE_API_KEY
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
            env.METEOFRANCE_API_KEY
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

  const response =
    await fetch(url);

  if (!response.ok) {

    throw new Error(
      `Vigicrues HTTP ${response.status}`
    );

  }

  const data =
    await response.json();

  const observations =
    data?.Serie?.ObssHydro;

  if (
    !Array.isArray(
      observations
    ) ||
    observations.length === 0
  ) {

    throw new Error(
      `Aucune observation pour ${station}`
    );

  }

  const derniere =
    observations[
      observations.length - 1
    ];

  return {

    debit:
      Number(
        derniere.ResObsHydro
      ),

    dateObservation:
      derniere.DtObsHydro

  };

}


// ==================================================
// SGL
// ==================================================

async function getSGL(idPoint) {

  const url =
    `https://sig.seinegrandslacs.fr/arcgis/rest/services/OGDE_mesures/MapServer/64/query` +
    `?where=id_pt_mesure%3D%27${encodeURIComponent(idPoint)}%27` +
    `&outFields=id_pt_mesure,lac,type_ouvrage,description,valeur1,date` +
    `&returnGeometry=false` +
    `&f=json`;

  const response =
    await fetch(url);

  if (!response.ok) {

    throw new Error(
      `SGL HTTP ${response.status}`
    );

  }

  const data =
    await response.json();

  if (
    !data.features ||
    data.features.length === 0
  ) {

    throw new Error(
      `Aucune donnée SGL pour ${idPoint}`
    );

  }

  const a =
    data.features[0].attributes;

  return {

    id:
      a.id_pt_mesure,

    debit:
      Number(a.valeur1),

    date:
      a.date,

    description:
      a.description

  };

}


// ==================================================
// COLLECTE VIGICRUES + SGL
// ==================================================

async function collecteEtStockage(env) {

  const montereau =
    await getDebit(
      "F400000102"
    );

  const episy =
    await getDebit(
      "F439000101"
    );

  const total =
    montereau.debit +
    episy.debit;
 
  const saintFargeau =
    await getDebit(
      "F447000302"
    );

  const sgl = {

    aube: {

      aube5: null,
      aube6: null,
      aube7: null,
      aube10: null,

      total: 0,
      erreurs: []

    },

    seine: {

      debit: null,
      erreurs: []

    },

    panneciere: {

      montigny: null,
      corancy: null,

      debitBrut: null,
      debitRelache: null,

      erreurs: []

    },

    total: 0,

    erreurs: []

  };


  // --------------------------------------------------
  // AUBE
  // --------------------------------------------------

  const aubePoints = [

    ["aube5", "Aube5"],
    ["aube6", "Aube6"],
    ["aube7", "Aube7"],
    ["aube10", "Aube10"]

  ];


  for (
    const [nom, idPoint]
    of aubePoints
  ) {

    try {

      const mesure =
        await getSGL(
          idPoint
        );

      sgl.aube[nom] =
        mesure;

      sgl.aube.total +=
        mesure.debit;

    } catch (error) {

      const message =
        `${idPoint} : ${error.message}`;

      sgl.aube.erreurs.push(
        message
      );

      sgl.erreurs.push(
        message
      );

    }

  }


  // --------------------------------------------------
  // SEINE
  // --------------------------------------------------

  try {

    const seine7 =
      await getSGL(
        "Seine7"
      );

    sgl.seine.debit =
      seine7.debit;

    sgl.seine.observation =
      seine7.date;

    sgl.seine.mesure =
      seine7;

  } catch (error) {

    const message =
      `Seine7 : ${error.message}`;

    sgl.seine.erreurs.push(
      message
    );

    sgl.erreurs.push(
      message
    );

  }


  // --------------------------------------------------
  // PANNECIERE
  // --------------------------------------------------

  let pann3 = null;
  let pann8 = null;


  try {

    pann3 =
      await getSGL(
        "Pann3"
      );

    sgl.panneciere.montigny =
      pann3;

  } catch (error) {

    const message =
      `Pann3 : ${error.message}`;

    sgl.panneciere.erreurs.push(
      message
    );

    sgl.erreurs.push(
      message
    );

  }


  try {

    pann8 =
      await getSGL(
        "Pann8"
      );

    sgl.panneciere.corancy =
      pann8;

  } catch (error) {

    const message =
      `Pann8 : ${error.message}`;

    sgl.panneciere.erreurs.push(
      message
    );

    sgl.erreurs.push(
      message
    );

  }


  // --------------------------------------------------
  // CALCUL PANNECIERE
  // --------------------------------------------------

  if (
    pann3 &&
    pann8
  ) {

    const debitPanneciereBrut =
      pann3.debit -
      pann8.debit;

    sgl.panneciere.debitBrut =
      debitPanneciereBrut;

    sgl.panneciere.debitRelache =
      Math.max(
        0,
        debitPanneciereBrut
      );

  }


  // --------------------------------------------------
  // TOTAL SGL
  // --------------------------------------------------

  sgl.total =
    sgl.aube.total +
    (sgl.seine.debit || 0) +
    (sgl.panneciere.debitRelache || 0);


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

    montereau: {

      debit:
        montereau.debit,

      observation:
        montereau.dateObservation

    },

    episy: {

      debit:
        episy.debit,

      observation:
        episy.dateObservation

    },

    total:
      total,

    sgl:
      sgl

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
  // HISTORIQUE DEBIT 30 JOURS
  // --------------------------------------------------

  let historiqueDebit =
    await env[
      "HYDRO"
    ].get(
      "debit_history",
      "json"
    );


  if (
    !Array.isArray(
      historiqueDebit
    )
  ) {

    historiqueDebit = [];

  }


  const nouvelleMesure = {

    t:
      heure.toISOString(),

    debit:
      total

  };


  const indexExistante =
    historiqueDebit.findIndex(
      m =>
        m.t ===
        nouvelleMesure.t
    );


  if (
    indexExistante >= 0
  ) {

    historiqueDebit[
      indexExistante
    ] =
      nouvelleMesure;

  } else {

    historiqueDebit.push(
      nouvelleMesure
    );

  }


  const limiteDebit =
    heure.getTime() -
    30 * 24 * 60 * 60 * 1000;


  historiqueDebit =
    historiqueDebit
      .filter(
        m =>
          new Date(
            m.t
          ).getTime() >=
          limiteDebit
      )
      .sort(
        (a, b) =>
          new Date(a.t).getTime() -
          new Date(b.t).getTime()
      )
      .slice(-720);


  await env[
    "HYDRO"
  ].put(
    "debit_history",
    JSON.stringify(
      historiqueDebit
    )
  );


  // --------------------------------------------------
  // HISTORIQUE DEBIT SAINT-FARGEAU-PONTHIERRY
  // --------------------------------------------------

  let historiqueSaintFargeau =
    await env[
      "HYDRO"
    ].get(
      "saint_fargeau_history",
      "json"
    );


  if (
    !Array.isArray(
      historiqueSaintFargeau
    )
  ) {

    historiqueSaintFargeau = [];

  }


  const nouvelleMesureSaintFargeau = {
    t:
      heure.toISOString(),
    debit:
      saintFargeau.debit
  };


  const indexExistanteSaintFargeau =
    historiqueSaintFargeau.findIndex(
      m =>
        m.t ===
        nouvelleMesureSaintFargeau.t
    );


  if (
    indexExistanteSaintFargeau >= 0
  ) {

    historiqueSaintFargeau[
      indexExistanteSaintFargeau
    ] =
      nouvelleMesureSaintFargeau;

  } else {

    historiqueSaintFargeau.push(
      nouvelleMesureSaintFargeau
    );

  }


  historiqueSaintFargeau =
    historiqueSaintFargeau
      .filter(
        m =>
          new Date(
            m.t
          ).getTime() >=
          limiteDebit
      )
      .sort(
        (a, b) =>
          new Date(a.t).getTime() -
          new Date(b.t).getTime()
      )
      .slice(-720);


  await env[
    "HYDRO"
  ].put(
    "saint_fargeau_history",
    JSON.stringify(
      historiqueSaintFargeau
    )
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

  const liste =
    await env[
      "HYDRO"
    ].list({
      prefix:
        "debit_"
    });


  const clesDebit =
    (liste.keys || [])
      .filter(
        key =>
          /^debit_\d{4}-\d{2}-\d{2}T/.test(
            key.name
          )
      );


  if (
    clesDebit.length === 0
  ) {

    return pageVide();

  }


  const cles =
    clesDebit
      .map(
        key =>
          key.name
      )
      .sort()
      .reverse();


  const derniereCle =
    cles[0];


  const texte =
    await env[
      "HYDRO"
    ].get(
      derniereCle
    );


  if (!texte) {

    return pageVide();

  }


  const mesure =
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
  // HISTORIQUE DEBIT
  // --------------------------------------------------

  const historiqueDebit =
    await env[
      "HYDRO"
    ].get(
      "debit_history",
      "json"
    );


  const debitGraphComplet =
  Array.isArray(
    historiqueDebit
  )
    ? historiqueDebit
    : [];


// --------------------------------------------------
// HISTORIQUE SAINT-FARGEAU-PONTHIERRY
// --------------------------------------------------

const historiqueSaintFargeau =
  await env[
    "HYDRO"
  ].get(
    "saint_fargeau_history",
    "json"
  );


const saintFargeauGraphComplet =
  Array.isArray(
    historiqueSaintFargeau
  )
    ? historiqueSaintFargeau
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

let debitGraph =
  debitGraphComplet;

let saintFargeauGraph =
  saintFargeauGraphComplet;


if (
  dureesPeriode[periode] &&
  debitGraphComplet.length > 0
) {

  const derniereDate =
    new Date(
      debitGraphComplet[
        debitGraphComplet.length - 1
      ].t
    ).getTime();

  const limite =
    derniereDate -
    dureesPeriode[periode];


  debitGraph =
    debitGraphComplet.filter(
      p =>
        new Date(p.t).getTime() >=
        limite
    );


  saintFargeauGraph =
    saintFargeauGraphComplet.filter(
      p =>
        new Date(p.t).getTime() >=
        limite
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
    debitGraph,
    saintFargeauGraph,
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
Météo hydro Chartrettes
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
Météo hydro Chartrettes
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
  debitGraph,
  saintFargeauGraph,
  previsions,
  periode = "tout"
) {

  const montereau =
    mesure.montereau || {};

  const episy =
    mesure.episy || {};

  const total =
    Number(
      mesure.total || 0
    );


  const sgl =
    mesure.sgl || null;


  const sglDisponible =
    !!(
      sgl &&
      sgl.aube &&
      sgl.seine &&
      sgl.panneciere
    );


  // --------------------------------------------------
  // DÉCALAGE VIGICRUES
  // --------------------------------------------------

  let decalageMinutes =
    0;


  if (
    montereau.observation &&
    episy.observation
  ) {

    const dateM =
      new Date(
        montereau.observation
      );

    const dateE =
      new Date(
        episy.observation
      );

    decalageMinutes =
      Math.abs(
        dateM.getTime() -
        dateE.getTime()
      ) / 60000;

  }


  const decalageSuperieurUneHeure =
    decalageMinutes > 60;


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
  // FORMAT DATE SGL
  // --------------------------------------------------

  function formatSGLDate(date) {

    if (
      date === null ||
      date === undefined
    ) {

      return "—";

    }

    return new Date(
      Number(date)
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
  // BLOC SGL
  // ==================================================

  let blocSGL = "";


  if (sglDisponible) {

    const erreursSGL =
      Array.isArray(
        sgl.erreurs
      )
        ? sgl.erreurs
        : [];


    blocSGL = `

<h2>
Seine Grands Lacs
</h2>

<div
  style="
    display:flex;
    align-items:baseline;
    gap:12px;
  "
>

<div class="sgl-total">

${formatDebit(
  sgl.total
)}
m³/s

</div>

<div class="subtitle">

Débit cumulé restitué par SGL

</div>

</div>


<table
  style="
    margin-top:10px
  "
>

<tr>

<th>
Restitution
</th>

<th>
Débit
</th>

<th>
Mesure
</th>

</tr>


<tr>

<td>
Aube
</td>

<td>

${formatDebit(
  sgl.aube.total
)}
m³/s

</td>

<td class="station-date">

Aube5 :
${sgl.aube.aube5
  ? formatSGLDate(
      sgl.aube.aube5.date
    )
  : "ERREUR"}

<br>

Aube6 :
${sgl.aube.aube6
  ? formatSGLDate(
      sgl.aube.aube6.date
    )
  : "ERREUR"}

<br>

Aube7 :
${sgl.aube.aube7
  ? formatSGLDate(
      sgl.aube.aube7.date
    )
  : "ERREUR"}

<br>

Aube10 :
${sgl.aube.aube10
  ? formatSGLDate(
      sgl.aube.aube10.date
    )
  : "ERREUR"}

</td>

</tr>


<tr>

<td>
Seine
</td>

<td>

${formatDebit(
  sgl.seine.debit
)}
m³/s

</td>

<td class="station-date">

${sgl.seine.mesure
  ? formatSGLDate(
      sgl.seine.mesure.date
    )
  : "ERREUR"}

</td>

</tr>


<tr>

<td>
Pannecière → Yonne
</td>

<td>

${formatDebit(
  sgl.panneciere.debitRelache
)}
m³/s

</td>

<td class="station-date">

M :
${sgl.panneciere.montigny
  ? formatSGLDate(
      sgl.panneciere.montigny.date
    )
  : "ERREUR"}

<br>

C :
${sgl.panneciere.corancy
  ? formatSGLDate(
      sgl.panneciere.corancy.date
    )
  : "ERREUR"}

</td>

</tr>


<tr class="total">

<td>
TOTAL SGL
</td>

<td>

${formatDebit(
  sgl.total
)}
m³/s

</td>

<td></td>

</tr>

</table>


${
  erreursSGL.length > 0

  ? `

<div class="warning">

⚠ Erreur sur une ou plusieurs mesures SGL :

<br><br>

${erreursSGL.join(
  "<br>"
)}

<br><br>

Les autres valeurs disponibles sont conservées dans le calcul.

</div>

`

  : ""

}

`;

  } else {

    blocSGL = `

<h2>
Seine Grands Lacs
</h2>

<div class="sgl-total">

—

</div>

<div class="subtitle">

Débit cumulé restitué par SGL

</div>

<div class="sgl-error">

Données SGL non disponibles pour cette mesure.

<br><br>

Erreur :

${sgl?.erreur ||
  "erreur inconnue"}

</div>

`;

  }


// ==================================================
// GRAPHE DEBIT — CHARTRETTES + SAINT-FARGEAU
// ==================================================

const graph =
  (() => {

    if (
      !Array.isArray(debitGraph) ||
      debitGraph.length < 2
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
    const margeBas = 30;

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
        debitGraph[0].t
      ).getTime();

    const tempsFin =
      new Date(
        debitGraph[
          debitGraph.length - 1
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
    // DONNEES CHARTRETTES
    // --------------------------------------------------

    const valeursChartrettes =
      debitGraph.map(
        p =>
          Number(p.debit)
      );


    // --------------------------------------------------
    // DONNEES SAINT-FARGEAU
    // --------------------------------------------------

    const valeursSaintFargeau =
      Array.isArray(saintFargeauGraph)
        ? saintFargeauGraph.map(
            p =>
              Number(p.debit)
          )
        : [];


    // --------------------------------------------------
    // ECHELLE COMMUNE
    // --------------------------------------------------

    const toutesLesValeurs =
      [
        ...valeursChartrettes,
        ...valeursSaintFargeau
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
    // COURBE CHARTRETTES
    // --------------------------------------------------

    const pointsChartrettes =
      debitGraph
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
    // COURBE SAINT-FARGEAU
    // --------------------------------------------------

    let pointsSaintFargeau = "";


    if (
      valeursSaintFargeau.length >= 2
    ) {

      pointsSaintFargeau =
        saintFargeauGraph
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


<!-- COURBE CHARTRETTES -->

<polyline
  points="${pointsChartrettes}"
  fill="none"
  stroke="#1976d2"
  stroke-width="2"
/>


<!-- COURBE SAINT-FARGEAU -->

${
  pointsSaintFargeau
    ? `
<polyline
  points="${pointsSaintFargeau}"
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


<!-- POINT CHARTRETTES -->

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
  id="debitPointSaintFargeau"
  cx="0"
  cy="0"
  r="4"
  fill="#e67e22"
  visibility="hidden"
  pointer-events="none"
/>



<!-- DATES -->

<text
  x="${margeGauche}"
  y="${hauteur - 8}"
  font-size="11"
  fill="#666"
>
${new Date(
  debitGraph[0].t
).toLocaleDateString(
  "fr-FR"
)}
</text>


<text
  x="${largeur - margeDroite}"
  y="${hauteur - 8}"
  text-anchor="end"
  font-size="11"
  fill="#666"
>
${new Date(
  debitGraph[
    debitGraph.length - 1
  ].t
).toLocaleDateString(
  "fr-FR"
)}
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
Précipitations prévues
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
Meteo hydro Chartrettes
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

.sgl-card {
  grid-area: sgl;
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
.sgl-card h2 {
  font-size: 15px;
  margin-bottom: 6px;
}

.sgl-card .sgl-total {
  font-size: 24px;
  margin: 2px 0 6px;
}

.sgl-card table {
  font-size: 11px;
}

.sgl-card th,
.sgl-card td {
  padding: 4px;
}

.sgl-card .station-date {
  font-size: 9px;
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


.sgl-total {

  font-size:
    32px;

  font-weight:
    bold;

  margin:
    4px 0 12px;

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


.sgl-error {

  margin-top:
    15px;

  padding:
    8px;

  background:
    #f3f5f7;

  border-radius:
    5px;

  font-size:
    12px;

  color:
    #777;

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
Meteo hydro Chartrettes
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
<!-- DEBIT -->
<!-- ============================================== -->

<div class="card debit-card">

<h2>
Débit Vigicrue
</h2>


<div
  style="
    display:flex;
    align-items:baseline;
    gap:12px;
  "
>

<div class="main-value">

${formatDebit(total)}
m³/s

</div>

<div class="subtitle">

Montereau + Épisy

</div>

</div>


<table style="margin-top:10px">

<tr>

<th>
Station
</th>

<th>
Débit
</th>

<th>
Surface
</th>

</tr>


<tr>

<td>

Seine — Montereau

<div class="station-date">

Mesure :
${formatDate(
  montereau.observation
)}

</div>

</td>

<td>

${formatDebit(
  montereau.debit
)}
m³/s

</td>

<td>

21 178 km²

</td>

</tr>


<tr>

<td>

Loing — Épisy

<div class="station-date">

Mesure :
${formatDate(
  episy.observation
)}

</div>

</td>

<td>

${formatDebit(
  episy.debit
)}
m³/s

</td>

<td>

3 900 km²

</td>

</tr>


<tr class="total">

<td>
TOTAL
</td>

<td>

${formatDebit(total)}
m³/s

</td>

<td></td>

</tr>

</table>


${
  decalageSuperieurUneHeure

    ? `

<div class="warning">

⚠ Attention : décalage des relevés entre les stations :
${Math.round(
  decalageMinutes
)}
minutes

</div>

`

    : ""
}


</div>


<!-- ============================================== -->
<!-- SGL -->
<!-- ============================================== -->

<div class="card sgl-card">

${blocSGL}

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
Chartrettes
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
Saint-Fargeau-Ponthierry
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
  Précipitations cumulées radar
  </h2>

  ${tableauRadar}

</div>


</div>


<script>
(() => {
  const data =
    ${JSON.stringify(
      debitGraph
    )};

  const dataSaintFargeau =
    ${JSON.stringify(
      saintFargeauGraph
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

  const pointSaintFargeau =
    document.getElementById(
      "debitPointSaintFargeau"
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
    !data.length
  ) {
    return;
  }


  const largeur = 800;
  const hauteur = 260;

  const margeGauche = 55;
  const margeDroite = 15;
  const margeHaut = 15;
  const margeBas = 30;


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
    ...data,
    ...dataSaintFargeau
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
      data[index];

    if (!p) {
      return;
    }


    const x =
      margeGauche +
      (
        index /
        (
          data.length -
          1
        )
      ) *
      graphW;


    // ------------------------------------------------
    // POINT CHARTRETTES
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
    // POINT SAINT-FARGEAU
    // ------------------------------------------------

    const pSF =
      dataSaintFargeau.find(
        q =>
          q.t === p.t
      );


    if (pSF) {

      const ySF =
        margeHaut +
        graphH -
        (
          (
            Number(
              pSF.debit
            ) -
            minDebit
          ) /
          amplitude
        ) *
        graphH;


      pointSaintFargeau.setAttribute(
        "cx",
        x
      );

      pointSaintFargeau.setAttribute(
        "cy",
        ySF
      );

      pointSaintFargeau.setAttribute(
        "visibility",
        "visible"
      );

    } else {

      pointSaintFargeau.setAttribute(
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

    let texteSaintFargeau =
      "—";

    if (pSF) {

      texteSaintFargeau =
        Number(
          pSF.debit
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

  "Chartrettes : " +
  Number(
    p.debit
  ).toFixed(1) +
  " m³/s<br>" +

  "<span style='color:#e67e22'>" +
  "●" +
  "</span> " +

  "Saint-Fargeau-Ponthierry : " +
  texteSaintFargeau;


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

    pointSaintFargeau.setAttribute(
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

  function positionDepuisEvenement(
    event
  ) {

    const rect =
      svg.getBoundingClientRect();


    const x =
      (
        event.clientX -
        rect.left
      ) /
      rect.width *
      largeur;


    let index =
      Math.round(
        (
          x -
          margeGauche
        ) /
        graphW *
        (
          data.length -
          1
        )
      );


    index =
      Math.max(
        0,
        Math.min(
          data.length -
          1,
          index
        )
      );


    afficher(
      index
    );

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
