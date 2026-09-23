import json, os

p = "package.json"
pkg = json.load(open(p))
key = "dependencies" if "@opencode/plugin" in pkg.get("dependencies", {}) else "peerDependencies"
pkg[key]["@opencode/plugin"] = os.environ["SDK_VERSION"]
base, n = pkg["version"].split("alpha.")
pkg["version"] = base + "alpha." + str(int(n) + 1)
json.dump(pkg, open(p, "w"), indent=2)
open(p, "a").write("\n")
print("bumped", p, "to", pkg["version"])
