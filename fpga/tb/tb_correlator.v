`timescale 1ns/1ps
module tb_correlator;
reg clk=0,reset_n=0,enable=1,valid=0;
reg [1:0] sid=0; reg [15:0] idx=0; reg signed [15:0] x=0;
always #5 clk=~clk;
wire rv,alarm; wire [1:0] rs; wire [15:0] ri; wire [54:0] energy; wire [3:0] alarms,published;
reg [33:0] samples[0:19999]; reg [73:0] expected[0:127];
reg [1023:0] input_file,expected_file;
integer n_samples,n_results,i,seen=0;
correlator dut(clk,reset_n,enable,sid,idx,x,valid,rv,rs,ri,energy,alarm,alarms,published);
always @(posedge clk) if(rv) begin
 if(seen>=n_results || {rs,ri,energy,alarm}!==expected[seen])
  $fatal(1,"FAIL correlation result %d got %h expected %h",seen,{rs,ri,energy,alarm},expected[seen]);
 seen=seen+1;
end
initial begin
 if(!$value$plusargs("INPUT=%s",input_file) || !$value$plusargs("EXPECTED=%s",expected_file) ||
    !$value$plusargs("SAMPLES=%d",n_samples) || !$value$plusargs("RESULTS=%d",n_results)) $fatal(1,"FAIL arguments");
 $readmemh(input_file,samples,0,n_samples-1); $readmemh(expected_file,expected,0,n_results-1);
 repeat(3) @(negedge clk); reset_n=1;
 // Dirty partial window, reset, then exact oracle comparison.
 valid=1; x=32767;
 repeat(37) @(negedge clk);
 reset_n=0; valid=0; repeat(3) @(negedge clk); reset_n=1;
 if(alarms || published || dut.count[0] || dut.accum_i[0]) $fatal(1,"FAIL detector reset");
 for(i=0;i<n_samples;i=i+1) begin
  @(negedge clk); {sid,idx,x}=samples[i]; valid=1;
 end
 @(negedge clk); valid=0;
 repeat(8) @(negedge clk);
 if(seen!=n_results) $fatal(1,"FAIL result count %d expected %d",seen,n_results);
 enable=0; repeat(3) @(negedge clk);
 if(alarms || published || rv) $fatal(1,"FAIL invalidation");
 $display("PASS correlator %0d samples, %0d exact integer results",n_samples,n_results); $finish;
end
initial begin #10000000; $fatal(1,"FAIL correlator timeout"); end
endmodule
