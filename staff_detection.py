"""Staff-line detection for aligning rendered MusicXML positions onto a scanned
score photo. Returns per-system, per-staff bounding boxes in image pixels."""
import cv2
import numpy as np


def detect_staves(image_path):
    """Detect staff-line groups in a music-score image.

    Returns:
        {
          "image_width": int,
          "image_height": int,
          "systems": [
             {"staves": [{"top_y", "bot_y", "left_x", "right_x", "lines": [y, ...]}, ...]},
             ...
          ]
        }
    """
    img = cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        return None
    h, w = img.shape

    _, binary = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)

    # Isolate long horizontal strokes (staff lines) with morphological opening.
    kernel_w = max(30, w // 20)
    h_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (kernel_w, 1))
    h_lines = cv2.morphologyEx(binary, cv2.MORPH_OPEN, h_kernel)

    # Row-projection: how many white pixels per row after isolating horizontal lines.
    row_sums = h_lines.sum(axis=1) / 255.0
    if row_sums.max() < 1:
        return {"image_width": w, "image_height": h, "systems": []}

    row_thresh = row_sums.max() * 0.3
    line_rows = np.where(row_sums > row_thresh)[0]
    if len(line_rows) == 0:
        return {"image_width": w, "image_height": h, "systems": []}

    # Collapse consecutive rows into a single line-centroid y.
    lines = []
    start = prev = line_rows[0]
    for r in line_rows[1:]:
        if r - prev <= 2:
            prev = r
        else:
            lines.append(int((start + prev) // 2))
            start = prev = r
    lines.append(int((start + prev) // 2))

    if len(lines) < 5:
        return {"image_width": w, "image_height": h, "systems": []}

    lines.sort()
    gaps = np.diff(lines)
    median_gap = float(np.median(gaps))

    # Cluster lines into staves of 5 using the median intra-staff gap.
    staves_lines = []
    current = [lines[0]]
    for i, g in enumerate(gaps):
        if g > median_gap * 1.8 or len(current) >= 5:
            if len(current) >= 4:
                staves_lines.append(current)
            current = [lines[i + 1]]
        else:
            current.append(lines[i + 1])
    if len(current) >= 4:
        staves_lines.append(current)

    # For each staff, get left/right by column-scanning the long-line image.
    staff_bboxes = []
    for sl in staves_lines:
        top_y = sl[0]
        bot_y = sl[-1]
        band = h_lines[max(0, top_y - 2):min(h, bot_y + 3), :]
        col_sums = band.sum(axis=0)
        # Column counts as part of the staff if at least 3 of the 5 lines pass through it.
        nonzero = np.where(col_sums >= 3 * 255)[0]
        if len(nonzero) < 5:
            continue
        left_x = int(nonzero[0])
        right_x = int(nonzero[-1])
        staff_bboxes.append({
            "top_y": int(top_y),
            "bot_y": int(bot_y),
            "left_x": left_x,
            "right_x": right_x,
            "lines": [int(y) for y in sl],
        })

    if not staff_bboxes:
        return {"image_width": w, "image_height": h, "systems": []}

    staff_bboxes.sort(key=lambda s: s["top_y"])

    inter_staff_gaps = [
        staff_bboxes[i + 1]["top_y"] - staff_bboxes[i]["bot_y"]
        for i in range(len(staff_bboxes) - 1)
    ]

    if not inter_staff_gaps:
        systems = [{"staves": staff_bboxes}]
    else:
        median_interstaff = float(np.median(inter_staff_gaps))
        # Split only when a gap is clearly larger than typical in-system spacing.
        # Use 1.3× median as the split threshold and require the gap to exceed
        # median + a safety margin (so noise within a uniform layout doesn't split).
        split_thresh = max(median_interstaff * 1.3, median_interstaff + 15)
        systems = []
        current_sys = [staff_bboxes[0]]
        for i, g in enumerate(inter_staff_gaps):
            if g > split_thresh:
                systems.append({"staves": current_sys})
                current_sys = [staff_bboxes[i + 1]]
            else:
                current_sys.append(staff_bboxes[i + 1])
        systems.append({"staves": current_sys})

    return {
        "image_width": int(w),
        "image_height": int(h),
        "systems": systems,
    }


if __name__ == "__main__":
    import sys
    import json
    path = sys.argv[1] if len(sys.argv) > 1 else "static/uploads/score_a3e5847c35.png"
    result = detect_staves(path)
    if result is None:
        print("Failed to load image")
        sys.exit(1)
    print(f"Image: {result['image_width']}x{result['image_height']}")
    print(f"Systems: {len(result['systems'])}")
    for i, sys_ in enumerate(result["systems"]):
        print(f"  System {i}: {len(sys_['staves'])} staves")
        for j, s in enumerate(sys_["staves"]):
            print(f"    Staff {j}: y=[{s['top_y']},{s['bot_y']}] x=[{s['left_x']},{s['right_x']}] lines={len(s['lines'])}")
