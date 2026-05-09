import unittest

from automation import get_latest_whatsapp_code


class FakeDevice:
    def __init__(self, xml):
        self.xml = xml
        self.opened = False
        self.back_pressed = False

    def open_notification(self):
        self.opened = True

    def dump_hierarchy(self):
        return self.xml

    def press(self, key):
        if key == "back":
            self.back_pressed = True


class WhatsAppCodeTests(unittest.TestCase):
    def test_reads_only_six_digit_gopay_code(self):
        device = FakeDevice("""
<hierarchy>
  <node text="Other app"/>
  <node text="1234"/>
  <node text="GoPay">
    <node text="987654 is your verification code. Don't share it with anyone."/>
  </node>
</hierarchy>
""")

        code = get_latest_whatsapp_code(device, lambda _msg: None)

        self.assertEqual(code, "987654")
        self.assertTrue(device.opened)
        self.assertTrue(device.back_pressed)

    def test_rejects_four_digit_codes_even_when_present(self):
        device = FakeDevice("""
<hierarchy>
  <node text="GoPay">
    <node text="Kode OTP kamu 1234"/>
  </node>
</hierarchy>
""")

        with self.assertRaisesRegex(RuntimeError, "GoPay 的 6 位 verification code 验证码"):
            get_latest_whatsapp_code(device, lambda _msg: None)

    def test_rejects_gopay_six_digit_code_without_verification_code_phrase(self):
        device = FakeDevice("""
<hierarchy>
  <node text="GoPay">
    <node text="Kode OTP kamu 987654. Jangan bagikan kode ini."/>
  </node>
</hierarchy>
""")

        with self.assertRaisesRegex(RuntimeError, "GoPay 的 6 位 verification code 验证码"):
            get_latest_whatsapp_code(device, lambda _msg: None)

    def test_rejects_six_digit_code_without_gopay_notification(self):
        device = FakeDevice("""
<hierarchy>
  <node text="WhatsApp">
    <node text="112233 is your verification code."/>
  </node>
</hierarchy>
""")

        with self.assertRaisesRegex(RuntimeError, "GoPay 的 6 位 verification code 验证码"):
            get_latest_whatsapp_code(device, lambda _msg: None)


if __name__ == "__main__":
    unittest.main()
