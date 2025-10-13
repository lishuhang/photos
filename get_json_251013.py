#!/usr/bin/env python3
"""
GitHub照片画廊JSON生成器 - v2.1

用法：
1. 将脚本放置在 data/ 目录的上级目录
2. 在GitHub网页版中展开需要生成的月份的所有日期文件夹
3. F12获取该月文件树的<li>标签的outerHTML，保存到文本文件
4. 运行: python get_json_v2.py <input_file>
5. 自动生成 data/yyyymm.json 文件（如 data/202510.json）

特性：
- 自动从图片文件名中提取年月信息
- 自动生成符合新命名规则的 JSON 文件名（yyyymm.json）
- 自动输出到 data/ 目录
- 如果文件已存在，自动覆盖（支持月内多次更新）
- 优化的错误提示和统计信息

作者：基于 get_json_251003.py 修改
版本：v2.1
日期：2025-10-13
"""

import sys
import re
import os
import json
from collections import defaultdict
from bs4 import BeautifulSoup

def extract_filenames_from_html(input_file):
    """
    从GitHub文件树HTML中提取文件名
    使用BeautifulSoup进行更准确的HTML解析
    """
    with open(input_file, 'r', encoding='utf-8') as file:
        content = file.read()

    try:
        # 使用BeautifulSoup解析HTML
        soup = BeautifulSoup(content, 'html.parser')
        
        # 查找所有包含文件名的span标签
        file_spans = soup.find_all('span', class_='PRIVATE_TreeView-item-content-text')
        
        file_names = []
        for span in file_spans:
            text = span.get_text().strip()
            # 检查是否是图片文件（包含扩展名）
            if '.' in text and any(text.lower().endswith(ext) for ext in ['.jpg', '.jpeg', '.png', '.gif', '.webp']):
                file_names.append(text)
        
        print(f"✓ 从HTML中提取到 {len(file_names)} 个图片文件名")
        return file_names
        
    except Exception as e:
        print(f"⚠ HTML解析失败，尝试使用正则表达式方法: {e}")
        
        # 备用方法：使用正则表达式
        # 移除HTML标签
        content = re.sub(r'<[^>]+>', '\n', content)
        content = re.sub(r'\n+', '\n', content)
        
        # 提取包含日期信息的图片文件名
        pattern = r'\b\d{8}\s+\d{6}\.(jpg|jpeg|png|gif|webp|JPG|JPEG|PNG|GIF|WEBP)\b'
        file_names = re.findall(pattern, content)
        file_names = [f"{match[0]}.{match[1]}" for match in file_names if isinstance(match, tuple)]
        
        # 如果上面的模式没找到，尝试更宽泛的模式
        if not file_names:
            pattern = r'\b\w*\d{4}[-_]?\d{2}[-_]?\d{2}[^<>\n]*\.(jpg|jpeg|png|gif|webp|JPG|JPEG|PNG|GIF|WEBP)\b'
            matches = re.findall(pattern, content)
            file_names = [match[0] + '.' + match[1] for match in matches if isinstance(match, tuple)]
        
        print(f"✓ 使用正则表达式提取到 {len(file_names)} 个文件名")
        return file_names

def extract_date_from_filename(filename):
    """
    从文件名中提取日期信息
    返回 (year, month, day) 元组
    """
    # 匹配各种日期格式：20250901, 2025-09-01, 2025_09_01等
    patterns = [
        r'(\d{4})(\d{2})(\d{2})',  # YYYYMMDD
        r'(\d{4})[-_](\d{2})[-_](\d{2})',  # YYYY-MM-DD 或 YYYY_MM_DD
    ]
    
    for pattern in patterns:
        match = re.search(pattern, filename)
        if match:
            return match.groups()
    
    return None

def group_files_by_date(file_names):
    """
    将文件按日期分组
    返回字典：{day: [filename1, filename2, ...]}
    """
    grouped_files = defaultdict(list)
    year_month_info = None
    
    for filename in file_names:
        date_info = extract_date_from_filename(filename)
        if date_info:
            year, month, day = date_info
            
            # 记录年月信息（所有文件应该属于同一个月）
            if year_month_info is None:
                year_month_info = (year, month)
            elif year_month_info != (year, month):
                print(f"⚠ 警告: 发现不同月份的文件 {filename} ({year}-{month})")
            
            # 按日期分组，使用两位数格式
            day_key = day.zfill(2)
            grouped_files[day_key].append(filename)
    
    print(f"✓ 文件按日期分组完成，共 {len(grouped_files)} 个日期")
    
    # 显示每个日期的文件数量
    for day in sorted(grouped_files.keys()):
        print(f"  {day}日: {len(grouped_files[day])} 个文件")
    
    return grouped_files, year_month_info

def generate_json_data(grouped_files, year_month_info):
    """
    生成符合新格式的JSON数据
    """
    if not year_month_info:
        raise ValueError("无法从文件名中提取年月信息")
    
    year, month = year_month_info
    
    # 构建JSON数据结构
    json_data = {
        "user_id": "modem-56k",
        "year": year,
        "month": month,
        "base_url": "https://raw.githubusercontent.com/{user_id}/img/main/{year}/{month}/{day}/",
        "photos": {}
    }
    
    # 按日期排序并添加到photos字段
    for day in sorted(grouped_files.keys()):
        # 对每个日期的文件名进行排序
        json_data["photos"][day] = sorted(grouped_files[day])
    
    return json_data

def save_json_file(json_data, output_dir="data"):
    """
    保存JSON数据到文件
    自动生成文件名：yyyymm.json
    如果文件已存在，将直接覆盖
    """
    try:
        # 创建输出目录（如果不存在）
        os.makedirs(output_dir, exist_ok=True)
        
        # 生成文件名：yyyymm.json
        year = json_data["year"]
        month = json_data["month"]
        filename = f"{year}{month}.json"
        output_path = os.path.join(output_dir, filename)
        
        # 检查文件是否已存在
        file_exists = os.path.exists(output_path)
        if file_exists:
            print(f"\n⚠ 检测到已存在的文件: {output_path}")
            print(f"📝 将覆盖原有文件...")
        
        # 保存JSON文件（如果已存在则覆盖）
        with open(output_path, 'w', encoding='utf-8') as file:
            json.dump(json_data, file, indent=2, ensure_ascii=False)
        
        if file_exists:
            print(f"✓ 文件已更新: {output_path}")
        else:
            print(f"\n✓ JSON文件已保存到: {output_path}")
        
        # 显示统计信息
        total_photos = sum(len(photos) for photos in json_data["photos"].values())
        print(f"\n📊 统计信息:")
        print(f"  年月: {year}-{month}")
        print(f"  日期数: {len(json_data['photos'])}")
        print(f"  照片总数: {total_photos}")
        
        # 显示示例URL
        if json_data["photos"]:
            first_day = next(iter(json_data["photos"]))
            first_photo = json_data["photos"][first_day][0]
            example_url = json_data["base_url"].format(
                user_id=json_data["user_id"],
                year=json_data["year"],
                month=json_data["month"],
                day=first_day
            ) + first_photo
            print(f"\n🔗 示例URL:")
            print(f"  {example_url}")
        
        return output_path
        
    except Exception as e:
        print(f"❌ 保存JSON文件时出错: {e}")
        return None

def main():
    """
    主函数
    """
    if len(sys.argv) != 2:
        print("=" * 60)
        print("GitHub照片画廊JSON生成器 - v2.1")
        print("=" * 60)
        print("\n用法:")
        print("  python get_json_v2.py <input_html_file>")
        print("\n步骤:")
        print("  0. 将此脚本放置在 data/ 目录的上级目录")
        print("\n  1. 在GitHub网页版中定位到图片库月份目录")
        print("     例如: https://github.com/modem-56k/img/tree/main/2025/10")
        print("\n  2. 展开该月的所有日期文件夹，显示所有图片文件")
        print("     （点击每个日期文件夹左侧的箭头展开）")
        print("\n  3. F12打开开发者工具，在Elements标签中:")
        print("     - 找到文件树的<li>标签")
        print("     - 右键 → Copy → Copy outerHTML")
        print("     - 保存到文本文件（如 outerhtml.txt）")
        print("\n  4. 运行此脚本:")
        print("     python get_json_v2.py outerhtml.txt")
        print("\n  5. 生成的JSON文件将自动保存到 data/yyyymm.json")
        print("     例如: data/202510.json")
        print("     ⚠ 如果文件已存在，将自动覆盖（支持月内多次更新）")
        print("\n示例:")
        print("  python get_json_v2.py github_202510.txt")
        print("  → 生成 data/202510.json")
        print("  → 如果 data/202510.json 已存在，将被覆盖")
        print("\n" + "=" * 60)
        return

    input_file = sys.argv[1]
    
    # 检查输入文件是否存在
    if not os.path.exists(input_file):
        print(f"❌ 错误: 文件不存在 - {input_file}")
        return

    try:
        print("\n" + "=" * 60)
        print(f"开始处理文件: {input_file}")
        print("=" * 60 + "\n")
        
        # 步骤1: 从HTML中提取文件名
        print("📝 步骤 1/4: 提取文件名...")
        file_names = extract_filenames_from_html(input_file)
        if not file_names:
            print("❌ 错误: 未找到任何图片文件名")
            print("\n提示:")
            print("  - 确保复制的是包含图片文件的<li>标签的outerHTML")
            print("  - 确保已展开所有日期文件夹")
            return
        
        # 步骤2: 按日期分组
        print("\n📅 步骤 2/4: 按日期分组...")
        grouped_files, year_month_info = group_files_by_date(file_names)
        if not grouped_files:
            print("❌ 错误: 无法从文件名中提取日期信息")
            print("\n提示:")
            print("  - 确保文件名包含日期信息（如 20251003 131748.jpg）")
            return
        
        if not year_month_info:
            print("❌ 错误: 无法确定年月信息")
            return
        
        year, month = year_month_info
        print(f"\n✓ 检测到年月: {year}-{month}")
        
        # 步骤3: 生成JSON数据
        print("\n🔧 步骤 3/4: 生成JSON数据...")
        json_data = generate_json_data(grouped_files, year_month_info)
        print(f"✓ JSON数据结构生成完成")
        
        # 步骤4: 保存JSON文件
        print("\n💾 步骤 4/4: 保存JSON文件...")
        output_path = save_json_file(json_data)
        
        if output_path:
            print("\n" + "=" * 60)
            print("✅ 处理完成!")
            print("=" * 60)
            print(f"\n生成的文件: {output_path}")
            print(f"文件名格式: {year}{month}.json")
            print("\n下一步:")
            print(f"  1. 将 {output_path} 上传到网站的 data/ 目录")
            print(f"  2. 在图片库页面中选择 {year}年{month}月查看照片")
        else:
            print("\n❌ 处理失败!")
        
    except Exception as e:
        print(f"\n❌ 处理过程中出错: {e}")
        import traceback
        traceback.print_exc()

if __name__ == "__main__":
    main()

