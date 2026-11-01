import sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'scripts'))
from verify_recovery import run

class RecoveryIntegration(unittest.TestCase):
    def test_two_completed_stops_fault_replan_cancel_reissue_and_actual_handover(self):
        with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as folder:
            result=run(folder)
            self.assertEqual(result['status'],'passed')
            self.assertEqual(result['delivered'],4)
            self.assertTrue(result['prefix_order_rows_byte_equal'])
            self.assertTrue(result['atomic_handover_rejection'])
            self.assertGreaterEqual(result['expected_rejections'],10)
            self.assertEqual(result,run(folder))

if __name__=='__main__':unittest.main()
