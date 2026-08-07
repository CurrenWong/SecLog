from PIL import Image
import os

path = r'D:\Project\SecLog\miniprogram\images\app-logo.png'
img = Image.open(path)
w, h = img.size
print(f'Original size: {w}x{h}, file: {os.path.getsize(path)/1024:.0f}KB')

# Resize to max 200px while maintaining aspect ratio
if w > 200 or h > 200:
    ratio = min(200/w, 200/h)
    img = img.resize((int(w*ratio), int(h*ratio)), Image.LANCZOS)

img.save(path, 'PNG', optimize=True)
print(f'New size: {img.size}, file: {os.path.getsize(path)/1024:.0f}KB')