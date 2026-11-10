import pandas as pd

g = pd.read_csv("esri_geocoded.csv", dtype=str)

# split "14.689619430107,121.083693681342" into lat and long
parts = g["latlong"].str.extract(r"\s*(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)\s*")
g["lat"] = pd.to_numeric(parts[0], errors="coerce")
g["long"] = pd.to_numeric(parts[1], errors="coerce")
g["score"] = pd.to_numeric(g["score"], errors="coerce")

print("Match types Esri returned:")
print(g["Addr_type"].value_counts(dropna=False).to_string())

# map Esri's match type to a precision label
PRECISION = {
    "PointAddress": "full", "Subaddress": "full", "StreetAddress": "full",
    "StreetAddressExt": "full", "StreetInt": "full", "POI": "full",
    "StreetName": "street",
    "Locality": "locality", "Postal": "locality", "PostalExt": "locality",
    "PostalLoc": "locality",
}
g["precision"] = g["Addr_type"].map(PRECISION).fillna("unknown")

bad = g[g["lat"].isna() | g["long"].isna()]
print(len(bad), "rows with no usable coordinates")

out = g.rename(columns={"clean_addr": "clean_address", "lat": "lat", "long": "long"})[
    ["clean_address", "lat", "long", "precision", "score", "address_ma"]
]
out = out.dropna(subset=["lat", "long"]).drop_duplicates("clean_address")
out.to_csv("geocoded_addresses.csv", index=False)

print(len(out), "rows written")
print(out["precision"].value_counts().to_string())
low = out[out["score"] < 90]
print(len(low), "rows with score below 90, worth checking by eye")