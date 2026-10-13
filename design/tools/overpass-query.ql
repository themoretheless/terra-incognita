[out:json][timeout:90];
(
  way["building"](48.852108,2.341933,48.860692,2.362533);
  way["highway"](48.852108,2.341933,48.860692,2.362533);
  way["railway"](48.852108,2.341933,48.860692,2.362533);
  way["natural"="water"](48.852108,2.341933,48.860692,2.362533);
  way["waterway"](48.852108,2.341933,48.860692,2.362533);
  relation["natural"="water"](48.852108,2.341933,48.860692,2.362533);
  way["leisure"~"^(park|garden|playground|pitch)$"](48.852108,2.341933,48.860692,2.362533);
  way["landuse"~"^(grass|forest|cemetery|recreation_ground|village_green)$"](48.852108,2.341933,48.860692,2.362533);
  relation["leisure"~"^(park|garden)$"](48.852108,2.341933,48.860692,2.362533);
  way["natural"="wood"](48.852108,2.341933,48.860692,2.362533);
  way["man_made"="bridge"](48.852108,2.341933,48.860692,2.362533);
);
out body; >; out skel qt;
