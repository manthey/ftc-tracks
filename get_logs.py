import argparse
import os
import shutil
import sys

import pythoncom
import win32com.client
import win32com.shell
import win32api
import win32con
import pywintypes
import ctypes

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument(
        '--source', '--src',
        default='Control Hub v1.0\\Internal shared storage\\FIRST\\telemetry',
        help='Path on device.  Default is "Control Hub v1.0\\Internal '
        'shared storage\\FIRST\\telemetry"',
    )
    parser.add_argument(
        '--dest', default='C:\\temp\\telemetry',
        help='Local destination path.  Default is "C:\\temp\\telemetry"')
    args = parser.parse_args()

    pythoncom.CoInitialize()

    shell = win32com.client.Dispatch('Shell.Application')
    folder = shell.Namespace(17)

    for part in args.source.replace('\\', '/').split('/'):
        found = False
        for item in folder.Items():
            if item.Name == part:
                folder = item.GetFolder
                found = True
                break
        if not found:
            print(f'Failed to find path component "{part}" in "{args.source}"')
            return

    os.makedirs(args.dest, exist_ok=True)
    dest = shell.Namespace(os.path.abspath(args.dest))

    items = sorted((item.Name, item) for item in folder.Items())
    for itemname, item in items:
        dest_path = os.path.join(args.dest, item.Name)
        if os.path.exists(dest_path):
            continue
        print(item.Name)
        dest.CopyHere(item, 4 | 16 | 512 | 1024)

    pythoncom.CoUninitialize()


if __name__ == '__main__':
    main()
