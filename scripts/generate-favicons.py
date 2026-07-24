import os
from PIL import Image, ImageDraw

def make_favicon_img(size):
    # Create transparent image
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    
    # Create mask for rounded background
    mask = Image.new("L", (size, size), 0)
    draw_mask = ImageDraw.Draw(mask)
    
    # Calculate dimensions relative to size
    padding_board = max(1, int(size * 0.0625))  # 2px for 32
    radius_board = max(2, int(size * 0.1875))   # 6px for 32
    
    draw_mask.rounded_rectangle(
        [padding_board, padding_board, size - padding_board - 1, size - padding_board - 1],
        radius=radius_board,
        fill=255
    )
    
    # Create gradient background
    grad = Image.new("RGBA", (size, size))
    for y in range(size):
        for x in range(size):
            # Diagonal gradient from bottom-left to top-right
            t = (x + (size - 1 - y)) / (2 * size - 2) if size > 1 else 0
            if t < 0.5:
                u = t / 0.5
                r = int(124 * (1 - u) + 236 * u)  # Purple (124, 58, 237) to Pink (236, 72, 153)
                g = int(58 * (1 - u) + 72 * u)
                b = int(237 * (1 - u) + 153 * u)
            else:
                u = (t - 0.5) / 0.5
                r = int(236 * (1 - u) + 249 * u)  # Pink (236, 72, 153) to Orange (249, 115, 22)
                g = int(72 * (1 - u) + 115 * u)
                b = int(153 * (1 - u) + 22 * u)
            grad.putpixel((x, y), (r, g, b, 255))
            
    # Apply gradient onto image using mask
    img.paste(grad, (0, 0), mask=mask)
    
    # Draw 2x2 white grid cells on top
    draw = ImageDraw.Draw(img)
    
    # Proportions for grid
    padding_grid = max(2, int(size * 0.15625))  # 5px for 32
    cell_size = max(2, int(size * 0.3125))     # 10px for 32
    spacing = max(1, int(size * 0.0625))       # 2px for 32
    radius_cell = max(1, int(size * 0.0625))    # 2px for 32
    
    # Cell 1 (top-left)
    x1, y1 = padding_grid, padding_grid
    draw.rounded_rectangle([x1, y1, x1 + cell_size - 1, y1 + cell_size - 1], radius=radius_cell, fill=(255, 255, 255, 255))
    
    # Cell 2 (top-right)
    x2, y2 = padding_grid + cell_size + spacing, padding_grid
    draw.rounded_rectangle([x2, y2, x2 + cell_size - 1, y2 + cell_size - 1], radius=radius_cell, fill=(255, 255, 255, 255))
    
    # Cell 3 (bottom-left)
    x3, y3 = padding_grid, padding_grid + cell_size + spacing
    draw.rounded_rectangle([x3, y3, x3 + cell_size - 1, y3 + cell_size - 1], radius=radius_cell, fill=(255, 255, 255, 255))
    
    # Cell 4 (bottom-right) - Draw with a slight opacity (e.g. 180 out of 255) to give distinct pinboard/board vibe
    x4, y4 = padding_grid + cell_size + spacing, padding_grid + cell_size + spacing
    draw.rounded_rectangle([x4, y4, x4 + cell_size - 1, y4 + cell_size - 1], radius=radius_cell, fill=(255, 255, 255, 180))
    
    return img

def main():
    out_dir = "apps/web/public"
    os.makedirs(out_dir, exist_ok=True)
    
    # 1. Save PNG icon (512x512)
    img_512 = make_favicon_img(512)
    img_512.save(os.path.join(out_dir, "icon.png"), format="PNG")
    print("Saved icon.png")
    
    # 2. Save apple-touch-icon.png (180x180)
    img_180 = make_favicon_img(180)
    img_180.save(os.path.join(out_dir, "apple-touch-icon.png"), format="PNG")
    print("Saved apple-touch-icon.png")
    
    # 3. Save favicon.ico (multi-resolution: 16x16, 32x32, 48x48)
    img_256 = make_favicon_img(256)
    img_256.save(os.path.join(out_dir, "favicon.ico"), format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])
    print("Saved favicon.ico")

if __name__ == "__main__":
    main()
