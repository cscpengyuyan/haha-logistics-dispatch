"""Probe private truck service with 50 state/DC Census highway pairs and four boundary cases.

Run from this checkout. Only synthetic public highway coordinates are used. This
exercises geometry/coverage, separately from ticket authorization or VROOM scheduling.
"""
import argparse
import csv
import json
import math
import os
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

PAIRS = Path(__file__).with_name("road-sample-pairs.json")
PARAMETERS = {"height": 3.3, "width": 2.45, "length": 8, "weight": 7.5, "axle_load": 4}
NO_CONTIGUOUS_US_ROAD = {"HI-cross-island", "AK-lower48"}


def query(url, payload=None):
    body = json.dumps(payload).encode() if payload else None
    with urlopen(Request(url, body, {"Content-Type": "application/json"}), timeout=18) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default=os.environ.get("HH_VALHALLA_URL", ""))
    parser.add_argument("--date", default=os.environ.get("HH_ROAD_DATA_DATE", ""))
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()
    base = args.base.rstrip("/")
    version = ""
    if base:
        health = query(base + "/status")
        version = health.get("version", "")
        if not args.date:
            args.date = health.get("data_date", "")
    pairs = json.loads(PAIRS.read_text(encoding="utf8"))
    results = []
    for area, (road, origin, stop) in pairs.items():
        status, miles, note = "未实证", "", "未配置全国货车服务"
        if version:
            try:
                options = {"costing":"truck","costing_options":{"truck":PARAMETERS},"units":"kilometers",
                    "locations":[{"lat":y,"lon":x,"search_cutoff":200} for y,x in (origin,stop)]}
                trip = query(base + "/route", options)["trip"]
                distance = trip["summary"]["length"]
                if not math.isfinite(distance) or distance <= 0:
                    raise ValueError("invalid road distance")
                miles = round(distance / 1.609344, 4)
                status = "已算道路" if area not in NO_CONTIGUOUS_US_ROAD else "需审核运输边界"
                note = "道路几何已返回" if status == "已算道路" else "含跨境或非公路条件，不签发"
            except (HTTPError, URLError, KeyError, ValueError, TimeoutError) as error:
                status = "未取得道路结果"
                note = str(error)
                if isinstance(error, HTTPError):
                    note = error.read(240).decode("utf8", "replace")
        results.append([area, road, *origin, *stop, status, miles, version, args.date, note])
    with args.out.open("w", encoding="utf-8-sig", newline="") as output:
        writer = csv.writer(output)
        writer.writerow(["地区", "公共道路样点", "起纬", "起经", "终纬", "终经", "实测结果", "英里", "Valhalla truck", "OSM图日期", "提示"])
        writer.writerows(results)
    print(f"{len(results)} pairs, {sum(r[6]=='已算道路' for r in results)} returned road geometry")


if __name__ == "__main__":
    main()
